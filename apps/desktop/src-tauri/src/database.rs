use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction, MAIN_DB};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::{
    BackupPayload, BackupResult, BookRecord, ChapterRecord, ChapterSummary, NoteRecord,
    NoteSummary, NotesExportPayload, NotesTransferResult, SaveImportedBookInput, SaveNoteInput,
    SearchResult,
};

#[derive(Clone)]
struct ActiveDatabase {
    data_directory: PathBuf,
    database_path: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DataDirectoryConfig {
    data_directory: String,
    #[serde(default)]
    database_path: Option<String>,
}

static HEADING_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<h[1-6](?:\s[^>]*)?>(.*?)</h[1-6]\s*>").expect("valid heading regex")
});
static HTML_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<[^>]+>").expect("valid HTML tag regex"));
static CHAPTER_HEADING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*[章回节]")
        .expect("valid chapter heading regex")
});

fn decode_generated_html_text(value: &str) -> String {
    HTML_TAG_RE
        .replace_all(value, " ")
        .replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn normalized_heading(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect()
}

fn chapter_heading_info(content: &str, title: &str) -> (Option<String>, Option<usize>) {
    let target = normalized_heading(title);
    let mut matching_heading_end = None;
    for captures in HEADING_TAG_RE.captures_iter(content) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        let Some(inner) = captures.get(1) else {
            continue;
        };
        let text = decode_generated_html_text(inner.as_str());
        if let Some(chapter) = CHAPTER_HEADING_RE.captures(&text) {
            if let Some(label) = chapter.get(1) {
                return (Some(label.as_str().to_string()), Some(whole.end()));
            }
        }
        if normalized_heading(&text) == target {
            matching_heading_end = Some(whole.end());
        }
    }
    (None, matching_heading_end)
}

fn repair_epub_chapter_structure(connection: &Connection, legacy: bool) -> Result<(), String> {
    let rows = {
        let mut statement = connection
            .prepare(
                "SELECT c.id, c.number, c.original_label, c.title, c.volume, c.kind, c.content
                 FROM chapters c JOIN books b ON b.id = c.book_id
                 WHERE b.source_format = 'epub' AND c.content_format = 'html'
                 ORDER BY c.book_id, c.number",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    for (id, _number, original_label, title, volume, stored_kind, content) in rows {
        let (chapter_label, heading_end) = chapter_heading_info(&content, &title);
        let inferred_kind = if chapter_label.is_some() {
            "chapter"
        } else if !volume.trim().is_empty()
            && normalized_heading(&title) == normalized_heading(&volume)
        {
            "volume"
        } else if volume.trim().is_empty() || volume == "前置内容" {
            "frontmatter"
        } else {
            "appendix"
        };
        let kind = if legacy
            || !matches!(
                stored_kind.as_str(),
                "frontmatter" | "volume" | "chapter" | "appendix"
            ) {
            inferred_kind
        } else {
            stored_kind.as_str()
        };
        let repaired_volume = if kind == "frontmatter" {
            "前置内容".to_string()
        } else {
            volume
        };
        let repaired_label = chapter_label.unwrap_or_else(|| {
            if kind == "chapter" {
                original_label
            } else {
                title.clone()
            }
        });
        let repaired_content = heading_end
            .map(|end| content[end..].to_string())
            .unwrap_or(content);
        let repaired_text = decode_generated_html_text(&repaired_content)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let word_count = repaired_text
            .chars()
            .filter(|character| !character.is_whitespace())
            .count() as i64;
        connection
            .execute(
                "UPDATE chapters SET original_label = ?2, volume = ?3, kind = ?4, content = ?5, content_text = ?6, word_count = ?7 WHERE id = ?1",
                params![id, repaired_label, repaired_volume, kind, repaired_content, repaired_text, word_count],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub struct DatabaseState {
    default_data_directory: PathBuf,
    config_path: PathBuf,
    legacy_config_path: Option<PathBuf>,
    active: RwLock<ActiveDatabase>,
}

impl DatabaseState {
    #[allow(dead_code)]
    pub fn initialize(default_data_directory: PathBuf) -> Result<Self, String> {
        let config_path = default_data_directory.join("config.json");
        Self::initialize_with_config(default_data_directory, config_path, None)
    }

    pub fn initialize_with_config(
        default_data_directory: PathBuf,
        config_path: PathBuf,
        legacy_config_path: Option<PathBuf>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&default_data_directory).map_err(|error| error.to_string())?;
        let active = load_configured_database(&config_path)
            .or_else(|| {
                legacy_config_path
                    .as_deref()
                    .and_then(load_configured_database)
            })
            .unwrap_or_else(|| ActiveDatabase {
                data_directory: default_data_directory.clone(),
                database_path: default_data_directory.join("library.db"),
            });
        fs::create_dir_all(&active.data_directory).map_err(|error| error.to_string())?;
        let state = Self {
            default_data_directory,
            config_path,
            legacy_config_path,
            active: RwLock::new(active),
        };
        state.persist_config()?;
        let connection = state.connect()?;
        migrate(&connection)?;
        Ok(state)
    }

    pub fn initialize_for_installation(
        default_data_directory: PathBuf,
        config_path: PathBuf,
        legacy_data_directory: PathBuf,
    ) -> Result<Self, String> {
        if config_path.is_file() {
            return Self::initialize_with_config(default_data_directory, config_path, None);
        }

        let legacy_config_path = legacy_data_directory.join("config.json");
        let legacy =
            load_configured_database(&legacy_config_path).unwrap_or_else(|| ActiveDatabase {
                data_directory: legacy_data_directory.clone(),
                database_path: legacy_data_directory.join("library.db"),
            });
        fs::create_dir_all(&default_data_directory).map_err(|error| error.to_string())?;
        let target_database = default_data_directory.join("library.db");
        if legacy.database_path.is_file() && legacy.database_path != target_database {
            let source =
                Connection::open(&legacy.database_path).map_err(|error| error.to_string())?;
            source
                .backup(MAIN_DB, &target_database, None)
                .map_err(|error| format!("迁移旧版书库失败：{error}"))?;
            drop(source);
            let target = Connection::open(&target_database).map_err(|error| error.to_string())?;
            migrate(&target)?;
            drop(target);
            remove_managed_database(&legacy.database_path);
        }

        let state = Self {
            default_data_directory: default_data_directory.clone(),
            config_path,
            legacy_config_path: None,
            active: RwLock::new(ActiveDatabase {
                data_directory: default_data_directory,
                database_path: target_database,
            }),
        };
        state.persist_config()?;
        for name in ["config.json", "bridge.json", "bridge-location.json"] {
            let _ = fs::remove_file(legacy_data_directory.join(name));
        }
        let _ = fs::remove_dir(&legacy_data_directory);
        let connection = state.connect()?;
        migrate(&connection)?;
        Ok(state)
    }

    pub fn connect(&self) -> Result<Connection, String> {
        let database_path = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据目录".to_string())?
            .database_path
            .clone();
        let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;\nPRAGMA journal_mode = WAL;\nPRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    pub fn storage_paths(&self) -> Result<(PathBuf, PathBuf), String> {
        let active = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据目录".to_string())?;
        Ok((active.data_directory.clone(), active.database_path.clone()))
    }

    pub fn default_data_directory(&self) -> PathBuf {
        self.default_data_directory.clone()
    }

    pub fn change_data_directory(&self, data_directory: PathBuf) -> Result<(), String> {
        if !data_directory.is_absolute() {
            return Err("数据目录必须是绝对路径".to_string());
        }
        fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
        let current = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据目录".to_string())?
            .clone();
        if current.data_directory == data_directory {
            return Ok(());
        }

        let target_database = data_directory.join("library.db");
        if current.database_path != target_database {
            let source = self.connect()?;
            source
                .backup(MAIN_DB, &target_database, None)
                .map_err(|error| error.to_string())?;
            let target = Connection::open(&target_database).map_err(|error| error.to_string())?;
            migrate(&target)?;
        }

        let config = DataDirectoryConfig {
            data_directory: data_directory.display().to_string(),
            database_path: Some(target_database.display().to_string()),
        };
        self.persist_config_value(&config)?;
        let mut active = self
            .active
            .write()
            .map_err(|_| "无法更新当前数据目录".to_string())?;
        *active = ActiveDatabase {
            data_directory,
            database_path: target_database,
        };
        drop(active);
        remove_managed_database(&current.database_path);
        Ok(())
    }

    pub fn reset_to_default_directory(&self) -> Result<(), String> {
        let current = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据目录".to_string())?
            .clone();
        if current.data_directory == self.default_data_directory {
            return Ok(());
        }
        fs::create_dir_all(&self.default_data_directory).map_err(|error| error.to_string())?;
        let target_database = self.default_data_directory.join("library.db");
        let source = self.connect()?;
        source
            .backup(MAIN_DB, &target_database, None)
            .map_err(|error| error.to_string())?;
        let target = Connection::open(&target_database).map_err(|error| error.to_string())?;
        migrate(&target)?;

        let config = DataDirectoryConfig {
            data_directory: self.default_data_directory.display().to_string(),
            database_path: Some(target_database.display().to_string()),
        };
        self.persist_config_value(&config)?;
        let mut active = self
            .active
            .write()
            .map_err(|_| "无法更新当前数据目录".to_string())?;
        *active = ActiveDatabase {
            data_directory: self.default_data_directory.clone(),
            database_path: target_database,
        };
        drop(active);
        remove_managed_database(&current.database_path);
        Ok(())
    }

    pub fn change_database_file(&self, database_path: PathBuf) -> Result<(), String> {
        if !database_path.is_absolute() {
            return Err("数据库文件必须使用绝对路径".to_string());
        }
        let data_directory = database_path
            .parent()
            .ok_or_else(|| "无法定位数据库所在目录".to_string())?
            .to_path_buf();
        fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
        let current = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据库文件".to_string())?
            .clone();
        if current.database_path == database_path {
            return Ok(());
        }

        if current.database_path != database_path {
            let source = self.connect()?;
            source
                .backup(MAIN_DB, &database_path, None)
                .map_err(|error| error.to_string())?;
            let target = Connection::open(&database_path).map_err(|error| error.to_string())?;
            migrate(&target)?;
        }

        let config = DataDirectoryConfig {
            data_directory: data_directory.display().to_string(),
            database_path: Some(database_path.display().to_string()),
        };
        self.persist_config_value(&config)?;
        let mut active = self
            .active
            .write()
            .map_err(|_| "无法更新当前数据库文件".to_string())?;
        *active = ActiveDatabase {
            data_directory,
            database_path,
        };
        drop(active);
        remove_managed_database(&current.database_path);
        Ok(())
    }

    fn persist_config(&self) -> Result<(), String> {
        let active = self
            .active
            .read()
            .map_err(|_| "无法读取当前数据库配置".to_string())?;
        let config = DataDirectoryConfig {
            data_directory: active.data_directory.display().to_string(),
            database_path: Some(active.database_path.display().to_string()),
        };
        drop(active);
        self.persist_config_value(&config)
    }

    fn persist_config_value(&self, config: &DataDirectoryConfig) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(config).map_err(|error| error.to_string())?;
        let mut paths = vec![self.config_path.clone()];
        if let Some(path) = &self.legacy_config_path {
            if !paths.iter().any(|candidate| candidate == path) {
                paths.push(path.clone());
            }
        }
        let mut written = false;
        let mut errors = Vec::new();
        for path in paths {
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            match fs::write(&path, &payload) {
                Ok(()) => written = true,
                Err(error) => errors.push(format!("{}：{}", path.display(), error)),
            }
        }
        if written {
            Ok(())
        } else {
            Err(format!("无法保存数据位置配置：{}", errors.join("；")))
        }
    }
}

fn remove_managed_database(database_path: &Path) {
    if !database_path.is_file() {
        return;
    }
    let _ = fs::remove_file(database_path);
    if let Some(name) = database_path.file_name().and_then(|value| value.to_str()) {
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(database_path.with_file_name(format!("{name}{suffix}")));
        }
    }
}

fn load_configured_database(config_path: &Path) -> Option<ActiveDatabase> {
    let source = fs::read(config_path).ok()?;
    let config: DataDirectoryConfig = serde_json::from_slice(&source).ok()?;
    let data_directory = PathBuf::from(config.data_directory);
    if !data_directory.is_absolute() {
        return None;
    }
    let database_path = config
        .database_path
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| data_directory.join("library.db"));
    Some(ActiveDatabase {
        data_directory,
        database_path,
    })
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let previous_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS books (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                author TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                source_name TEXT NOT NULL DEFAULT '',
                source_size INTEGER NOT NULL DEFAULT 0,
                encoding TEXT NOT NULL DEFAULT '',
                chapter_count INTEGER NOT NULL DEFAULT 0,
                total_words INTEGER NOT NULL DEFAULT 0,
                volumes_json TEXT NOT NULL DEFAULT '[]',
                theme_json TEXT NOT NULL,
                parse_options_json TEXT NOT NULL,
                current_chapter INTEGER NOT NULL DEFAULT 1,
                progress REAL NOT NULL DEFAULT 0,
                chapter_progress REAL NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                last_read_at INTEGER NOT NULL,
                source_format TEXT NOT NULL DEFAULT 'txt',
                cover_data_url TEXT
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id TEXT PRIMARY KEY,
                book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
                number INTEGER NOT NULL,
                original_label TEXT NOT NULL,
                title TEXT NOT NULL,
                volume TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                content_text TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                content_format TEXT NOT NULL DEFAULT 'text',
                kind TEXT NOT NULL DEFAULT 'chapter',
                UNIQUE(book_id, number)
            );

            CREATE INDEX IF NOT EXISTS idx_books_last_read_at ON books(last_read_at DESC);
            CREATE INDEX IF NOT EXISTS idx_chapters_book_number ON chapters(book_id, number);

            CREATE TABLE IF NOT EXISTS notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '',
                content_html TEXT NOT NULL DEFAULT '',
                content_text TEXT NOT NULL DEFAULT '',
                is_pinned INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(is_pinned DESC, updated_at DESC);
            "#,
        )
        .map_err(|error| error.to_string())?;

    let has_chapter_progress = {
        let mut statement = connection
            .prepare("PRAGMA table_info(books)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        columns.iter().any(|column| column == "chapter_progress")
    };
    if !has_chapter_progress {
        connection
            .execute(
                "ALTER TABLE books ADD COLUMN chapter_progress REAL NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    let book_columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(books)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        columns
    };
    if !book_columns.iter().any(|column| column == "source_format") {
        connection
            .execute(
                "ALTER TABLE books ADD COLUMN source_format TEXT NOT NULL DEFAULT 'txt'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    if !book_columns.iter().any(|column| column == "cover_data_url") {
        connection
            .execute("ALTER TABLE books ADD COLUMN cover_data_url TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    let chapter_columns = {
        let mut statement = connection
            .prepare("PRAGMA table_info(chapters)")
            .map_err(|error| error.to_string())?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        columns
    };
    if !chapter_columns
        .iter()
        .any(|column| column == "content_format")
    {
        connection
            .execute(
                "ALTER TABLE chapters ADD COLUMN content_format TEXT NOT NULL DEFAULT 'text'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    if !chapter_columns
        .iter()
        .any(|column| column == "content_text")
    {
        connection
            .execute(
                "ALTER TABLE chapters ADD COLUMN content_text TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE chapters SET content_text = content WHERE content_text = ''",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    if !chapter_columns.iter().any(|column| column == "kind") {
        connection
            .execute(
                "ALTER TABLE chapters ADD COLUMN kind TEXT NOT NULL DEFAULT 'chapter'",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute(
            "UPDATE chapters SET volume = title WHERE content_format = 'html' AND trim(volume) = '' AND EXISTS (SELECT 1 FROM chapters AS member WHERE member.book_id = chapters.book_id AND member.volume = chapters.title)",
            [],
        )
        .map_err(|error| error.to_string())?;
    if previous_version < 5 {
        repair_epub_chapter_structure(connection, true)?;
    }
    connection
        .execute_batch("PRAGMA user_version = 5")
        .map_err(|error| error.to_string())
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn json<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn parse_json<T: serde::de::DeserializeOwned>(value: String) -> Result<T, rusqlite::Error> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn map_book(row: &rusqlite::Row<'_>) -> Result<BookRecord, rusqlite::Error> {
    Ok(BookRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        author: row.get(2)?,
        description: row.get(3)?,
        source_name: row.get(4)?,
        source_size: row.get(5)?,
        encoding: row.get(6)?,
        chapter_count: row.get(7)?,
        total_words: row.get(8)?,
        volumes: parse_json(row.get(9)?)?,
        theme: parse_json(row.get(10)?)?,
        parse_options: parse_json(row.get(11)?)?,
        current_chapter: row.get(12)?,
        progress: row.get(13)?,
        chapter_progress: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        last_read_at: row.get(17)?,
        source_format: row.get(18)?,
        cover_data_url: row.get(19)?,
    })
}

const BOOK_COLUMNS: &str = "id, title, author, description, source_name, source_size, encoding, chapter_count, total_words, volumes_json, theme_json, parse_options_json, current_chapter, progress, chapter_progress, created_at, updated_at, last_read_at, source_format, cover_data_url";

fn map_note(row: &rusqlite::Row<'_>) -> Result<NoteRecord, rusqlite::Error> {
    Ok(NoteRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        content_html: row.get(2)?,
        content_text: row.get(3)?,
        is_pinned: row.get::<_, i64>(4)? != 0,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const NOTE_COLUMNS: &str =
    "id, title, content_html, content_text, is_pinned, created_at, updated_at";

pub fn save_imported_book(
    connection: &mut Connection,
    input: SaveImportedBookInput,
) -> Result<BookRecord, String> {
    if input.result.chapters.is_empty() {
        return Err("没有可保存的章节".to_string());
    }

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let id = input
        .existing_id
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let previous = find_book_in_transaction(&transaction, &id)?;
    let now = now_millis();
    let chapter_count = input.result.chapters.len() as i64;
    let total_words: i64 = input
        .result
        .chapters
        .iter()
        .map(|chapter| chapter.word_count)
        .sum();
    let volumes: Vec<String> = input
        .result
        .chapters
        .iter()
        .filter(|chapter| chapter.kind != "frontmatter")
        .map(|chapter| chapter.volume.trim())
        .filter(|volume| !volume.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let current_chapter = previous
        .as_ref()
        .map(|book| book.current_chapter.min(chapter_count).max(1))
        .unwrap_or(1);
    let progress = previous.as_ref().map(|book| book.progress).unwrap_or(0.0);
    let chapter_progress = previous
        .as_ref()
        .map(|book| book.chapter_progress)
        .unwrap_or(0.0);
    let created_at = previous.as_ref().map(|book| book.created_at).unwrap_or(now);
    let last_read_at = previous
        .as_ref()
        .map(|book| book.last_read_at)
        .unwrap_or(now);
    let author = if input.result.metadata.author.trim().is_empty() {
        "佚名".to_string()
    } else {
        input.result.metadata.author.trim().to_string()
    };

    transaction
        .execute("DELETE FROM chapters WHERE book_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            &format!(
                "INSERT INTO books ({BOOK_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)\n                 ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, description=excluded.description, source_name=excluded.source_name, source_size=excluded.source_size, encoding=excluded.encoding, chapter_count=excluded.chapter_count, total_words=excluded.total_words, volumes_json=excluded.volumes_json, theme_json=excluded.theme_json, parse_options_json=excluded.parse_options_json, current_chapter=excluded.current_chapter, progress=excluded.progress, chapter_progress=excluded.chapter_progress, updated_at=excluded.updated_at, last_read_at=excluded.last_read_at, source_format=excluded.source_format, cover_data_url=excluded.cover_data_url"
            ),
            params![
                id,
                input.result.metadata.title.trim(),
                author,
                input.result.metadata.description.trim(),
                input.result.metadata.source_name,
                input.result.metadata.source_size,
                input.result.metadata.encoding,
                chapter_count,
                total_words,
                json(&volumes)?,
                json(&input.theme)?,
                json(&input.options)?,
                current_chapter,
                progress,
                chapter_progress,
                created_at,
                now,
                last_read_at,
                input.result.metadata.source_format,
                input.result.metadata.cover_data_url
            ],
        )
        .map_err(|error| error.to_string())?;

    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO chapters (id, book_id, number, original_label, title, volume, kind, content, content_text, word_count, content_format) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )
            .map_err(|error| error.to_string())?;
        for chapter in &input.result.chapters {
            statement
                .execute(params![
                    format!("{}:{}", id, chapter.number),
                    id,
                    chapter.number,
                    chapter.original_label,
                    chapter.title,
                    chapter.volume,
                    chapter.kind,
                    chapter.content,
                    chapter.content_text,
                    chapter.word_count,
                    chapter.content_format
                ])
                .map_err(|error| error.to_string())?;
        }
    }

    transaction.commit().map_err(|error| error.to_string())?;
    get_book(connection, &id)?.ok_or_else(|| "保存后无法读取书籍".to_string())
}

fn find_book_in_transaction(
    transaction: &Transaction<'_>,
    id: &str,
) -> Result<Option<BookRecord>, String> {
    transaction
        .query_row(
            &format!("SELECT {BOOK_COLUMNS} FROM books WHERE id = ?1"),
            params![id],
            map_book,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_books(connection: &Connection) -> Result<Vec<BookRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {BOOK_COLUMNS} FROM books ORDER BY last_read_at DESC, updated_at DESC"
        ))
        .map_err(|error| error.to_string())?;
    let books = statement
        .query_map([], map_book)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(books)
}

pub fn get_book(connection: &Connection, id: &str) -> Result<Option<BookRecord>, String> {
    connection
        .query_row(
            &format!("SELECT {BOOK_COLUMNS} FROM books WHERE id = ?1"),
            params![id],
            map_book,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_chapters(
    connection: &Connection,
    book_id: &str,
) -> Result<Vec<ChapterSummary>, String> {
    let mut statement = connection
        .prepare("SELECT id, book_id, number, original_label, title, volume, kind, word_count, content_format FROM chapters WHERE book_id = ?1 ORDER BY number")
        .map_err(|error| error.to_string())?;
    let chapters = statement
        .query_map(params![book_id], |row| {
            Ok(ChapterSummary {
                id: row.get(0)?,
                book_id: row.get(1)?,
                number: row.get(2)?,
                original_label: row.get(3)?,
                title: row.get(4)?,
                volume: row.get(5)?,
                kind: row.get(6)?,
                word_count: row.get(7)?,
                content_format: row.get(8)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(chapters)
}

pub fn get_chapter(
    connection: &Connection,
    book_id: &str,
    number: i64,
) -> Result<Option<ChapterRecord>, String> {
    connection
        .query_row(
            "SELECT id, book_id, number, original_label, title, volume, kind, content, content_text, word_count, content_format FROM chapters WHERE book_id = ?1 AND number = ?2",
            params![book_id, number],
            |row| {
                Ok(ChapterRecord {
                    id: row.get(0)?,
                    book_id: row.get(1)?,
                    number: row.get(2)?,
                    original_label: row.get(3)?,
                    title: row.get(4)?,
                    volume: row.get(5)?,
                    kind: row.get(6)?,
                    content: row.get(7)?,
                    content_text: row.get(8)?,
                    word_count: row.get(9)?,
                    content_format: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn save_progress(
    connection: &Connection,
    book_id: &str,
    chapter_number: i64,
    chapter_progress: f64,
) -> Result<(), String> {
    let chapter_count: i64 = connection
        .query_row(
            "SELECT chapter_count FROM books WHERE id = ?1",
            params![book_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let normalized_progress = chapter_progress.clamp(0.0, 100.0);
    let normalized_chapter = chapter_number.max(1);
    let overall = (((normalized_chapter - 1) as f64 + normalized_progress / 100.0)
        / chapter_count.max(1) as f64
        * 100.0)
        .clamp(0.0, 100.0);
    connection
        .execute(
            "UPDATE books SET current_chapter = ?2, progress = ?3, chapter_progress = ?4, last_read_at = ?5 WHERE id = ?1",
            params![book_id, normalized_chapter, overall, normalized_progress, now_millis()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn delete_book(connection: &Connection, book_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM books WHERE id = ?1", params![book_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn search(connection: &Connection, query: &str) -> Result<Vec<SearchResult>, String> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{needle}%");
    let mut statement = connection
        .prepare(
            "SELECT c.book_id, b.title, c.number, c.original_label, c.kind, c.title, substr(c.content_text, 1, 180) FROM chapters c JOIN books b ON b.id = c.book_id WHERE b.title LIKE ?1 OR b.author LIKE ?1 OR c.title LIKE ?1 OR c.content_text LIKE ?1 ORDER BY b.last_read_at DESC, c.number LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let results = statement
        .query_map(params![pattern], |row| {
            Ok(SearchResult {
                book_id: row.get(0)?,
                book_title: row.get(1)?,
                chapter_number: row.get(2)?,
                original_label: row.get(3)?,
                kind: row.get(4)?,
                chapter_title: row.get(5)?,
                snippet: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(results)
}

pub fn list_notes(connection: &Connection, query: &str) -> Result<Vec<NoteSummary>, String> {
    let pattern = format!("%{}%", query.trim());
    let mut statement = connection
        .prepare(
            "SELECT id, title, substr(content_text, 1, 180), is_pinned, created_at, updated_at FROM notes WHERE ?1 = '%%' OR title LIKE ?1 OR content_text LIKE ?1 ORDER BY is_pinned DESC, updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let notes = statement
        .query_map(params![pattern], |row| {
            Ok(NoteSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                excerpt: row.get(2)?,
                is_pinned: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(notes)
}

pub fn get_note(connection: &Connection, note_id: &str) -> Result<Option<NoteRecord>, String> {
    connection
        .query_row(
            &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE id = ?1"),
            params![note_id],
            map_note,
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn create_note(connection: &Connection, title: &str) -> Result<NoteRecord, String> {
    let id = Uuid::new_v4().to_string();
    let timestamp = now_millis();
    let title = normalized_note_title(title);
    connection
        .execute(
            "INSERT INTO notes (id, title, content_html, content_text, is_pinned, created_at, updated_at) VALUES (?1, ?2, '<p></p>', '', 0, ?3, ?3)",
            params![id, title, timestamp],
        )
        .map_err(|error| error.to_string())?;
    get_note(connection, &id)?.ok_or_else(|| "笔记创建失败".to_string())
}

pub fn save_note(connection: &Connection, input: SaveNoteInput) -> Result<NoteRecord, String> {
    let title = normalized_note_title(&input.title);
    let changed = connection
        .execute(
            "UPDATE notes SET title = ?2, content_html = ?3, content_text = ?4, is_pinned = ?5, updated_at = ?6 WHERE id = ?1",
            params![
                input.id,
                title,
                input.content_html,
                input.content_text,
                i64::from(input.is_pinned),
                now_millis()
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("要保存的笔记不存在".to_string());
    }
    get_note(connection, &input.id)?.ok_or_else(|| "笔记保存失败".to_string())
}

pub fn set_note_pinned(
    connection: &Connection,
    note_id: &str,
    is_pinned: bool,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE notes SET is_pinned = ?2, updated_at = ?3 WHERE id = ?1",
            params![note_id, i64::from(is_pinned), now_millis()],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("要置顶的笔记不存在".to_string());
    }
    Ok(())
}

pub fn duplicate_note(connection: &Connection, note_id: &str) -> Result<NoteRecord, String> {
    let source = get_note(connection, note_id)?.ok_or_else(|| "要复制的笔记不存在".to_string())?;
    let id = Uuid::new_v4().to_string();
    let timestamp = now_millis();
    let title = format!("{} - 副本", source.title);
    connection
        .execute(
            "INSERT INTO notes (id, title, content_html, content_text, is_pinned, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
            params![id, title, source.content_html, source.content_text, timestamp],
        )
        .map_err(|error| error.to_string())?;
    get_note(connection, &id)?.ok_or_else(|| "笔记复制失败".to_string())
}

pub fn delete_note(connection: &Connection, note_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM notes WHERE id = ?1", params![note_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn normalized_note_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        "无标题笔记".to_string()
    } else {
        trimmed.chars().take(160).collect()
    }
}

fn list_all_notes(connection: &Connection) -> Result<Vec<NoteRecord>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM notes ORDER BY is_pinned DESC, updated_at DESC"
        ))
        .map_err(|error| error.to_string())?;
    let notes = statement
        .query_map([], map_note)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(notes)
}

fn upsert_notes(transaction: &Transaction<'_>, notes: &[NoteRecord]) -> Result<(), String> {
    let mut statement = transaction
        .prepare(&format!(
            "INSERT INTO notes ({NOTE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title, content_html=excluded.content_html, content_text=excluded.content_text, is_pinned=excluded.is_pinned, created_at=excluded.created_at, updated_at=excluded.updated_at"
        ))
        .map_err(|error| error.to_string())?;
    for note in notes {
        statement
            .execute(params![
                note.id,
                note.title,
                note.content_html,
                note.content_text,
                i64::from(note.is_pinned),
                note.created_at,
                note.updated_at
            ])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn export_notes(
    connection: &Connection,
    target_path: &Path,
) -> Result<NotesTransferResult, String> {
    let payload = NotesExportPayload {
        format: "novel-library-notes".to_string(),
        version: 1,
        exported_at: now_millis(),
        notes: list_all_notes(connection)?,
    };
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        target_path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(NotesTransferResult {
        path: target_path.display().to_string(),
        notes: payload.notes.len(),
    })
}

pub fn import_notes(
    connection: &mut Connection,
    source_path: &Path,
) -> Result<NotesTransferResult, String> {
    let source = fs::read(source_path).map_err(|error| error.to_string())?;
    let payload: NotesExportPayload =
        serde_json::from_slice(&source).map_err(|error| format!("笔记文件格式错误：{error}"))?;
    if payload.format != "novel-library-notes" || payload.version != 1 {
        return Err("不支持的笔记导入版本".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    upsert_notes(&transaction, &payload.notes)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(NotesTransferResult {
        path: source_path.display().to_string(),
        notes: payload.notes.len(),
    })
}

pub fn write_text_file(target_path: &Path, content: &str) -> Result<String, String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target_path, content.as_bytes()).map_err(|error| error.to_string())?;
    Ok(target_path.display().to_string())
}

fn list_all_chapters(connection: &Connection) -> Result<Vec<ChapterRecord>, String> {
    let mut statement = connection
        .prepare("SELECT id, book_id, number, original_label, title, volume, kind, content, content_text, word_count, content_format FROM chapters ORDER BY book_id, number")
        .map_err(|error| error.to_string())?;
    let chapters = statement
        .query_map([], |row| {
            Ok(ChapterRecord {
                id: row.get(0)?,
                book_id: row.get(1)?,
                number: row.get(2)?,
                original_label: row.get(3)?,
                title: row.get(4)?,
                volume: row.get(5)?,
                kind: row.get(6)?,
                content: row.get(7)?,
                content_text: row.get(8)?,
                word_count: row.get(9)?,
                content_format: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(chapters)
}

pub fn export_backup(connection: &Connection, target_path: &Path) -> Result<BackupResult, String> {
    let books = list_books(connection)?;
    let chapters = list_all_chapters(connection)?;
    let notes = list_all_notes(connection)?;
    let payload = BackupPayload {
        format: "novel-library-backup".to_string(),
        version: 4,
        created_at: now_millis(),
        books,
        chapters,
        notes,
    };
    let source = serde_json::to_vec(&payload).map_err(|error| error.to_string())?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(target_path, source).map_err(|error| error.to_string())?;
    Ok(BackupResult {
        path: target_path.display().to_string(),
        books: payload.books.len(),
        chapters: payload.chapters.len(),
        notes: payload.notes.len(),
    })
}

pub fn import_backup(
    connection: &mut Connection,
    source_path: &Path,
) -> Result<BackupResult, String> {
    let source = fs::read(source_path).map_err(|error| error.to_string())?;
    let payload: BackupPayload =
        serde_json::from_slice(&source).map_err(|error| format!("备份格式错误：{error}"))?;
    if payload.format != "novel-library-backup" || !(1..=4).contains(&payload.version) {
        return Err("不支持的小说书库备份版本".to_string());
    }
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    for book in &payload.books {
        transaction
            .execute("DELETE FROM chapters WHERE book_id = ?1", params![book.id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                &format!(
                    "INSERT INTO books ({BOOK_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)\n                     ON CONFLICT(id) DO UPDATE SET title=excluded.title, author=excluded.author, description=excluded.description, source_name=excluded.source_name, source_size=excluded.source_size, encoding=excluded.encoding, chapter_count=excluded.chapter_count, total_words=excluded.total_words, volumes_json=excluded.volumes_json, theme_json=excluded.theme_json, parse_options_json=excluded.parse_options_json, current_chapter=excluded.current_chapter, progress=excluded.progress, chapter_progress=excluded.chapter_progress, created_at=excluded.created_at, updated_at=excluded.updated_at, last_read_at=excluded.last_read_at, source_format=excluded.source_format, cover_data_url=excluded.cover_data_url"
                ),
                params![
                    book.id,
                    book.title,
                    book.author,
                    book.description,
                    book.source_name,
                    book.source_size,
                    book.encoding,
                    book.chapter_count,
                    book.total_words,
                    json(&book.volumes)?,
                    json(&book.theme)?,
                    json(&book.parse_options)?,
                    book.current_chapter,
                    book.progress,
                    book.chapter_progress,
                    book.created_at,
                    book.updated_at,
                    book.last_read_at,
                    book.source_format,
                    book.cover_data_url
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO chapters (id, book_id, number, original_label, title, volume, kind, content, content_text, word_count, content_format) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO UPDATE SET book_id=excluded.book_id, number=excluded.number, original_label=excluded.original_label, title=excluded.title, volume=excluded.volume, kind=excluded.kind, content=excluded.content, content_text=excluded.content_text, word_count=excluded.word_count, content_format=excluded.content_format",
            )
            .map_err(|error| error.to_string())?;
        for chapter in &payload.chapters {
            statement
                .execute(params![
                    chapter.id,
                    chapter.book_id,
                    chapter.number,
                    chapter.original_label,
                    chapter.title,
                    chapter.volume,
                    chapter.kind,
                    chapter.content,
                    if chapter.content_text.is_empty() {
                        &chapter.content
                    } else {
                        &chapter.content_text
                    },
                    chapter.word_count,
                    chapter.content_format
                ])
                .map_err(|error| error.to_string())?;
        }
    }

    repair_epub_chapter_structure(&transaction, payload.version <= 3)?;
    upsert_notes(&transaction, &payload.notes)?;

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(BackupResult {
        path: source_path.display().to_string(),
        books: payload.books.len(),
        chapters: payload.chapters.len(),
        notes: payload.notes.len(),
    })
}

pub fn database_exists(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ParseOptions, ParseResult, ParsedChapter, ParsedMetadata, SaveNoteInput, ThemeSettings,
    };

    fn sample_import() -> SaveImportedBookInput {
        SaveImportedBookInput {
            result: ParseResult {
                metadata: ParsedMetadata {
                    title: "桌面测试书".to_string(),
                    author: "测试作者".to_string(),
                    description: "数据库验收".to_string(),
                    encoding: "utf-8".to_string(),
                    source_name: "desktop-test.txt".to_string(),
                    source_size: 128,
                    source_format: "txt".to_string(),
                    cover_data_url: None,
                },
                chapters: vec![
                    ParsedChapter {
                        number: 1,
                        original_label: "一".to_string(),
                        title: "开始".to_string(),
                        volume: "第一卷".to_string(),
                        kind: "chapter".to_string(),
                        content: "第一章正文。".to_string(),
                        content_text: "第一章正文。".to_string(),
                        content_format: "text".to_string(),
                        word_count: 6,
                    },
                    ParsedChapter {
                        number: 2,
                        original_label: "二".to_string(),
                        title: "继续".to_string(),
                        volume: "第一卷".to_string(),
                        kind: "chapter".to_string(),
                        content: "第二章包含青石长阶。".to_string(),
                        content_text: "第二章包含青石长阶。".to_string(),
                        content_format: "text".to_string(),
                        word_count: 10,
                    },
                ],
                warnings: Vec::new(),
            },
            theme: ThemeSettings {
                preset: "ink".to_string(),
                accent: "#c9a866".to_string(),
                background: "#101719".to_string(),
                text: "#f1f2ef".to_string(),
                overlay: 48.0,
                position_x: 50.0,
                position_y: 50.0,
                cover_asset_id: None,
            },
            options: ParseOptions {
                encoding: "auto".to_string(),
                chapter_pattern: String::new(),
                ad_patterns: String::new(),
                merge_wrapped: true,
                remove_ads: true,
            },
            existing_id: None,
        }
    }

    #[test]
    fn creates_schema_in_memory() {
        let connection = Connection::open_in_memory().expect("open database");
        migrate(&connection).expect("migrate database");
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read version");
        assert_eq!(version, 5);
    }

    #[test]
    fn migrates_schema_three_books_without_losing_txt_content() {
        let mut connection = Connection::open_in_memory().expect("open database");
        migrate(&connection).expect("create current schema");
        let book = save_imported_book(&mut connection, sample_import()).expect("save txt book");
        connection
            .execute_batch(
                "ALTER TABLE books DROP COLUMN source_format;
                 ALTER TABLE books DROP COLUMN cover_data_url;
                 ALTER TABLE chapters DROP COLUMN content_text;
                 ALTER TABLE chapters DROP COLUMN content_format;
                 PRAGMA user_version = 3;",
            )
            .expect("simulate schema three");

        migrate(&connection).expect("migrate schema three");
        let restored_book = get_book(&connection, &book.id)
            .expect("read migrated book")
            .expect("migrated book exists");
        let restored_chapter = get_chapter(&connection, &book.id, 1)
            .expect("read migrated chapter")
            .expect("migrated chapter exists");
        assert_eq!(restored_book.source_format, "txt");
        assert!(restored_book.cover_data_url.is_none());
        assert_eq!(restored_chapter.content_format, "text");
        assert_eq!(restored_chapter.content, "第一章正文。");
    }

    #[test]
    fn repairs_existing_epub_volume_dividers() {
        let mut connection = Connection::open_in_memory().expect("open database");
        migrate(&connection).expect("create schema");
        let book = save_imported_book(&mut connection, sample_import()).expect("save book");
        connection
            .execute(
                "UPDATE books SET source_format = 'epub' WHERE id = ?1",
                params![book.id],
            )
            .expect("mark book as epub");
        connection
            .execute(
                "UPDATE chapters SET title = '第一部 小丑', volume = '', content = '<h1>第一部 小丑</h1><p>卷首装饰</p>', content_format = 'html' WHERE book_id = ?1 AND number = 1",
                params![book.id],
            )
            .expect("prepare misplaced divider");
        connection
            .execute(
                "UPDATE chapters SET volume = '第一部 小丑', content = '<h1>第十四章 继续</h1><p>正文</p>', content_format = 'html' WHERE book_id = ?1 AND number = 2",
                params![book.id],
            )
            .expect("prepare volume member");
        connection
            .execute_batch("PRAGMA user_version = 4")
            .expect("set legacy version");

        migrate(&connection).expect("repair existing epub groups");
        let divider = get_chapter(&connection, &book.id, 1)
            .expect("read divider")
            .expect("divider exists");
        assert_eq!(divider.volume, "第一部 小丑");
        assert_eq!(divider.kind, "volume");
        assert_eq!(divider.content, "<p>卷首装饰</p>");
        let chapter = get_chapter(&connection, &book.id, 2)
            .expect("read repaired chapter")
            .expect("chapter exists");
        assert_eq!(chapter.kind, "chapter");
        assert_eq!(chapter.original_label, "十四");
        assert_eq!(chapter.content, "<p>正文</p>");
    }

    #[test]
    fn completes_note_create_edit_search_pin_duplicate_and_delete_flow() {
        let connection = Connection::open_in_memory().expect("open database");
        migrate(&connection).expect("migrate database");

        let note = create_note(&connection, "灵感记录").expect("create note");
        let updated = save_note(
            &connection,
            SaveNoteInput {
                id: note.id.clone(),
                title: "世界观灵感".to_string(),
                content_html: "<h2>青石城</h2><p>城门外有一座旧碑。</p>".to_string(),
                content_text: "青石城 城门外有一座旧碑。".to_string(),
                is_pinned: false,
            },
        )
        .expect("save note");
        assert_eq!(updated.title, "世界观灵感");
        assert_eq!(
            list_notes(&connection, "旧碑").expect("search notes").len(),
            1
        );

        set_note_pinned(&connection, &note.id, true).expect("pin note");
        assert!(
            get_note(&connection, &note.id)
                .expect("get pinned note")
                .expect("pinned note exists")
                .is_pinned
        );

        let duplicate = duplicate_note(&connection, &note.id).expect("duplicate note");
        assert!(duplicate.title.ends_with("副本"));
        assert_eq!(list_notes(&connection, "").expect("list notes").len(), 2);

        delete_note(&connection, &note.id).expect("delete note");
        assert!(get_note(&connection, &note.id)
            .expect("get deleted note")
            .is_none());
    }

    #[test]
    fn exports_and_imports_notes_collection() {
        let source = Connection::open_in_memory().expect("open source database");
        migrate(&source).expect("migrate source database");
        let note = create_note(&source, "导出测试").expect("create source note");
        save_note(
            &source,
            SaveNoteInput {
                id: note.id,
                title: "导出测试".to_string(),
                content_html: "<p>可移植笔记正文</p>".to_string(),
                content_text: "可移植笔记正文".to_string(),
                is_pinned: true,
            },
        )
        .expect("save source note");

        let notes_path =
            std::env::temp_dir().join(format!("novel-library-notes-test-{}.json", Uuid::new_v4()));
        let exported = export_notes(&source, &notes_path).expect("export notes");
        assert_eq!(exported.notes, 1);

        let mut target = Connection::open_in_memory().expect("open target database");
        migrate(&target).expect("migrate target database");
        let imported = import_notes(&mut target, &notes_path).expect("import notes");
        assert_eq!(imported.notes, 1);
        let restored = list_notes(&target, "可移植").expect("search restored notes");
        assert_eq!(restored.len(), 1);
        assert!(restored[0].is_pinned);

        fs::remove_file(notes_path).expect("remove notes fixture");
    }

    #[test]
    fn completes_import_read_progress_search_and_delete_flow() {
        let mut connection = Connection::open_in_memory().expect("open database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON")
            .expect("enable foreign keys");
        migrate(&connection).expect("migrate database");

        let book = save_imported_book(&mut connection, sample_import()).expect("save book");
        assert_eq!(book.chapter_count, 2);
        assert_eq!(book.total_words, 16);
        assert_eq!(book.source_format, "txt");
        assert_eq!(list_books(&connection).expect("list books").len(), 1);
        assert_eq!(
            list_chapters(&connection, &book.id)
                .expect("list chapters")
                .len(),
            2
        );
        assert_eq!(
            get_chapter(&connection, &book.id, 2)
                .expect("get chapter")
                .expect("chapter exists")
                .content_format,
            "text"
        );

        save_progress(&connection, &book.id, 2, 50.0).expect("save progress");
        let updated = get_book(&connection, &book.id)
            .expect("get book")
            .expect("book exists");
        assert_eq!(updated.current_chapter, 2);
        assert_eq!(updated.progress, 75.0);
        assert_eq!(updated.chapter_progress, 50.0);

        let results = search(&connection, "青石长阶").expect("search library");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].chapter_number, 2);

        delete_book(&connection, &book.id).expect("delete book");
        assert!(get_book(&connection, &book.id)
            .expect("get deleted book")
            .is_none());
        assert!(list_chapters(&connection, &book.id)
            .expect("list deleted chapters")
            .is_empty());
    }

    #[test]
    fn exports_and_restores_portable_backup() {
        let mut source = Connection::open_in_memory().expect("open source database");
        source
            .execute_batch("PRAGMA foreign_keys = ON")
            .expect("enable foreign keys");
        migrate(&source).expect("migrate source database");
        save_imported_book(&mut source, sample_import()).expect("save source book");
        create_note(&source, "随书笔记").expect("save source note");

        let backup_path =
            std::env::temp_dir().join(format!("novel-library-backup-test-{}.json", Uuid::new_v4()));
        let exported = export_backup(&source, &backup_path).expect("export backup");
        assert_eq!(exported.books, 1);
        assert_eq!(exported.chapters, 2);
        assert_eq!(exported.notes, 1);

        let mut target = Connection::open_in_memory().expect("open target database");
        target
            .execute_batch("PRAGMA foreign_keys = ON")
            .expect("enable foreign keys");
        migrate(&target).expect("migrate target database");
        let imported = import_backup(&mut target, &backup_path).expect("import backup");
        assert_eq!(imported.books, 1);
        assert_eq!(imported.chapters, 2);
        assert_eq!(imported.notes, 1);
        assert_eq!(list_books(&target).expect("list restored books").len(), 1);
        assert_eq!(
            list_notes(&target, "").expect("list restored notes").len(),
            1
        );
        assert_eq!(
            search(&target, "青石长阶")
                .expect("search restored database")
                .len(),
            1
        );

        fs::remove_file(backup_path).expect("remove backup fixture");
    }

    #[test]
    fn imports_version_two_backup_without_epub_fields() {
        let mut source = Connection::open_in_memory().expect("open source database");
        migrate(&source).expect("migrate source database");
        save_imported_book(&mut source, sample_import()).expect("save source book");
        let backup_path = std::env::temp_dir().join(format!(
            "novel-library-legacy-backup-test-{}.json",
            Uuid::new_v4()
        ));
        export_backup(&source, &backup_path).expect("export current backup");

        let mut payload: serde_json::Value =
            serde_json::from_slice(&fs::read(&backup_path).expect("read current backup"))
                .expect("parse current backup");
        payload["version"] = serde_json::Value::from(2);
        for book in payload["books"].as_array_mut().expect("backup books") {
            book.as_object_mut()
                .expect("book object")
                .remove("sourceFormat");
            book.as_object_mut()
                .expect("book object")
                .remove("coverDataUrl");
        }
        for chapter in payload["chapters"].as_array_mut().expect("backup chapters") {
            chapter
                .as_object_mut()
                .expect("chapter object")
                .remove("contentFormat");
            chapter
                .as_object_mut()
                .expect("chapter object")
                .remove("contentText");
        }
        fs::write(
            &backup_path,
            serde_json::to_vec(&payload).expect("serialize legacy backup"),
        )
        .expect("write legacy backup");

        let mut target = Connection::open_in_memory().expect("open target database");
        migrate(&target).expect("migrate target database");
        import_backup(&mut target, &backup_path).expect("import version two backup");
        let restored = list_books(&target).expect("list legacy books");
        assert_eq!(restored[0].source_format, "txt");
        assert_eq!(
            get_chapter(&target, &restored[0].id, 1)
                .expect("read legacy chapter")
                .expect("legacy chapter exists")
                .content_format,
            "text"
        );

        fs::remove_file(backup_path).expect("remove legacy backup fixture");
    }

    #[test]
    fn switches_data_directory_and_remembers_selection() {
        let root =
            std::env::temp_dir().join(format!("novel-library-directory-test-{}", Uuid::new_v4()));
        let default_directory = root.join("default");
        let custom_directory = root.join("custom");
        let custom_database = root.join("database").join("my-library.sqlite");
        let state = DatabaseState::initialize(default_directory.clone()).expect("initialize state");
        save_imported_book(
            &mut state.connect().expect("connect default"),
            sample_import(),
        )
        .expect("save default book");

        state
            .change_data_directory(custom_directory.clone())
            .expect("change directory");
        assert_eq!(
            state.storage_paths().expect("read paths").0,
            custom_directory
        );
        assert_eq!(
            list_books(&state.connect().expect("connect custom"))
                .expect("list custom books")
                .len(),
            1
        );

        let reloaded = DatabaseState::initialize(default_directory).expect("reload state");
        assert_eq!(
            reloaded.storage_paths().expect("read reloaded paths").0,
            custom_directory
        );
        assert_eq!(
            list_books(&reloaded.connect().expect("connect reloaded"))
                .expect("list reloaded books")
                .len(),
            1
        );

        reloaded
            .change_database_file(custom_database.clone())
            .expect("change database file");
        assert_eq!(
            reloaded.storage_paths().expect("read database path").1,
            custom_database
        );
        assert_eq!(
            list_books(&reloaded.connect().expect("connect custom file"))
                .expect("list custom file books")
                .len(),
            1
        );

        save_progress(
            &reloaded.connect().expect("connect selected"),
            &list_books(&reloaded.connect().expect("read selected"))
                .expect("list selected")
                .remove(0)
                .id,
            2,
            50.0,
        )
        .expect("update selected progress");
        reloaded
            .reset_to_default_directory()
            .expect("reset default directory");
        assert_eq!(
            list_books(&reloaded.connect().expect("connect reset")).expect("list reset books")[0]
                .progress,
            75.0
        );

        drop(reloaded);
        drop(state);
        fs::remove_dir_all(root).expect("remove directory fixture");
    }

    #[test]
    fn migrates_legacy_appdata_database_to_installation_data_and_cleans_legacy_files() {
        let root = std::env::temp_dir().join(format!(
            "novel-library-installation-migration-test-{}",
            Uuid::new_v4()
        ));
        let legacy_directory = root.join("AppData").join("NovelLibrary");
        let install_directory = root.join("NovelLibrary");
        let install_data = install_directory.join("NovelLibraryData");
        let legacy_state =
            DatabaseState::initialize(legacy_directory.clone()).expect("initialize legacy state");
        save_imported_book(
            &mut legacy_state.connect().expect("connect legacy"),
            sample_import(),
        )
        .expect("save legacy book");
        drop(legacy_state);

        let migrated = DatabaseState::initialize_for_installation(
            install_data.clone(),
            install_directory.join("NovelLibrary.storage.json"),
            legacy_directory.clone(),
        )
        .expect("migrate installation state");
        assert_eq!(
            list_books(&migrated.connect().expect("connect migrated"))
                .expect("list migrated books")
                .len(),
            1
        );
        assert!(install_data.join("library.db").is_file());
        assert!(!legacy_directory.join("library.db").exists());
        assert!(!legacy_directory.join("config.json").exists());

        drop(migrated);
        fs::remove_dir_all(root).expect("remove migration fixture");
    }
}
