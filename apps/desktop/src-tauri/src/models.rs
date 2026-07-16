use serde::{Deserialize, Serialize};

fn default_source_format() -> String {
    "txt".to_string()
}

fn default_content_format() -> String {
    "text".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseOptions {
    pub encoding: String,
    pub chapter_pattern: String,
    pub ad_patterns: String,
    pub merge_wrapped: bool,
    pub remove_ads: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSettings {
    pub preset: String,
    pub accent: String,
    pub background: String,
    pub text: String,
    pub overlay: f64,
    pub position_x: f64,
    pub position_y: f64,
    pub cover_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMetadata {
    pub title: String,
    pub author: String,
    pub description: String,
    pub encoding: String,
    pub source_name: String,
    pub source_size: i64,
    #[serde(default = "default_source_format")]
    pub source_format: String,
    #[serde(default)]
    pub cover_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedChapter {
    pub number: i64,
    pub original_label: String,
    pub title: String,
    pub volume: String,
    pub content: String,
    #[serde(default)]
    pub content_text: String,
    #[serde(default = "default_content_format")]
    pub content_format: String,
    pub word_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub metadata: ParsedMetadata,
    pub chapters: Vec<ParsedChapter>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveImportedBookInput {
    pub result: ParseResult,
    pub theme: ThemeSettings,
    pub options: ParseOptions,
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub source_name: String,
    pub source_size: i64,
    pub encoding: String,
    #[serde(default = "default_source_format")]
    pub source_format: String,
    #[serde(default)]
    pub cover_data_url: Option<String>,
    pub chapter_count: i64,
    pub total_words: i64,
    pub volumes: Vec<String>,
    pub theme: ThemeSettings,
    pub parse_options: ParseOptions,
    pub current_chapter: i64,
    pub progress: f64,
    pub chapter_progress: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_read_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSummary {
    pub id: String,
    pub book_id: String,
    pub number: i64,
    pub original_label: String,
    pub title: String,
    pub volume: String,
    pub word_count: i64,
    #[serde(default = "default_content_format")]
    pub content_format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterRecord {
    pub id: String,
    pub book_id: String,
    pub number: i64,
    pub original_label: String,
    pub title: String,
    pub volume: String,
    pub content: String,
    #[serde(default)]
    pub content_text: String,
    pub word_count: i64,
    #[serde(default = "default_content_format")]
    pub content_format: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProgressInput {
    pub book_id: String,
    pub chapter_number: i64,
    pub chapter_progress: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub book_id: String,
    pub book_title: String,
    pub chapter_number: i64,
    pub chapter_title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub content_html: String,
    pub content_text: String,
    pub is_pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub is_pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveNoteInput {
    pub id: String,
    pub title: String,
    pub content_html: String,
    pub content_text: String,
    pub is_pinned: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub database_ready: bool,
    pub data_directory: String,
    pub database_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPayload {
    pub format: String,
    pub version: u32,
    pub created_at: i64,
    pub books: Vec<BookRecord>,
    pub chapters: Vec<ChapterRecord>,
    #[serde(default)]
    pub notes: Vec<NoteRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub path: String,
    pub books: usize,
    pub chapters: usize,
    pub notes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesExportPayload {
    pub format: String,
    pub version: u32,
    pub exported_at: i64,
    pub notes: Vec<NoteRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesTransferResult {
    pub path: String,
    pub notes: usize,
}
