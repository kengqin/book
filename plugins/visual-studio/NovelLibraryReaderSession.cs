using System;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace NovelLibrary.VisualStudio;

internal enum ReaderDisplayMode
{
    Paragraph,
    LineEnd
}

internal sealed class BookItem
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public int? CurrentChapter { get; set; }
    public double ChapterProgress { get; set; }
    public override string ToString() => Title;
}

internal sealed class ChapterItem
{
    public int Number { get; set; }
    public int Ordinal { get; set; }
    public string Title { get; set; } = "";
    public string Kind { get; set; }
    public override string ToString() => Ordinal > 0 ? $"第 {Ordinal} 章 · {Title}" : Title;
}

internal sealed class ChapterPayload
{
    public int Number { get; set; }
    public string Title { get; set; } = "";
    public string ContentText { get; set; } = "";
    public string Content { get; set; } = "";
}

internal static class NovelLibraryReaderSession
{
    private static readonly NovelLibraryBridge Bridge = new NovelLibraryBridge();
    private static readonly SemaphoreSlim Gate = new SemaphoreSlim(1, 1);
    private static bool _loaded;
    private static List<string> _lines = new List<string>();
    private static int _lineStart;
    private static readonly string DisplayModePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "NovelLibrary",
        "visual-studio-display-mode.txt");
    private static readonly string VisibilityPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "NovelLibrary",
        "visual-studio-reader-visible.txt");

    public static event EventHandler Changed;
    public static IReadOnlyList<BookItem> Books { get; private set; } = Array.Empty<BookItem>();
    public static IReadOnlyList<ChapterItem> Chapters { get; private set; } = Array.Empty<ChapterItem>();
    public static BookItem CurrentBook { get; private set; }
    public static ChapterPayload CurrentChapter { get; private set; }
    public static IReadOnlyList<string> VisibleLines => _lines.Skip(_lineStart).Take(5).ToArray();
    public static ReaderDisplayMode DisplayMode { get; private set; } = LoadDisplayMode();
    public static bool IsReaderVisible { get; private set; } = LoadVisibility();
    public static string DisplayModeLabel => DisplayMode == ReaderDisplayMode.Paragraph ? "段落模式" : "行尾模式";
    public static string VisibilityLabel => IsReaderVisible ? "关闭阅读" : "开启阅读";
    public static int CurrentChapterOrdinal => CurrentChapterIndex + 1;
    public static bool HasPreviousChapter => CurrentChapterIndex > 0;
    public static bool HasNextChapter => CurrentChapterIndex >= 0 && CurrentChapterIndex < Chapters.Count - 1;
    public static double OverallProgress => CurrentChapterIndex < 0 || Chapters.Count == 0
        ? 0d
        : Math.Max(0d, Math.Min(100d, (CurrentChapterIndex + ChapterProgress / 100d) / Chapters.Count * 100d));
    public static string Header => CurrentChapter == null
        ? "尚未加载章节 · 总进度 0.0%"
        : $"第 {CurrentChapterOrdinal}/{Chapters.Count} 章 · {CurrentChapter.Title} · 总进度 {OverallProgress:F1}%";
    public static string Status => CurrentChapter == null
        ? "正在连接小说书库桌面端"
        : _lines.Count == 0
            ? $"{CurrentChapter.Title} · 当前章节没有可阅读的正文 · {DisplayModeLabel}"
        : $"{CurrentChapter.Title} · {_lineStart + 1}-{Math.Min(_lines.Count, _lineStart + 5)} / {_lines.Count} 行 · {DisplayModeLabel}";

    private static int CurrentChapterIndex => CurrentChapter == null
        ? -1
        : Chapters.ToList().FindIndex(item => item.Number == CurrentChapter.Number);

    private static double ChapterProgress => _lines.Count == 0
        ? 0d
        : _lines.Count <= 5 ? 100d : _lineStart * 100d / (_lines.Count - 5);

    public static void ToggleDisplayMode()
    {
        DisplayMode = DisplayMode == ReaderDisplayMode.Paragraph
            ? ReaderDisplayMode.LineEnd
            : ReaderDisplayMode.Paragraph;
        Directory.CreateDirectory(Path.GetDirectoryName(DisplayModePath));
        File.WriteAllText(DisplayModePath, DisplayMode == ReaderDisplayMode.Paragraph ? "paragraph" : "lineEnd");
        RaiseChanged();
    }

    public static void ToggleVisibility()
    {
        IsReaderVisible = !IsReaderVisible;
        Directory.CreateDirectory(Path.GetDirectoryName(VisibilityPath));
        File.WriteAllText(VisibilityPath, IsReaderVisible ? "visible" : "hidden");
        RaiseChanged();
    }

    private static ReaderDisplayMode LoadDisplayMode()
    {
        try
        {
            return File.Exists(DisplayModePath) && File.ReadAllText(DisplayModePath).Trim() == "lineEnd"
                ? ReaderDisplayMode.LineEnd
                : ReaderDisplayMode.Paragraph;
        }
        catch
        {
            return ReaderDisplayMode.Paragraph;
        }
    }

    private static bool LoadVisibility()
    {
        try
        {
            return !File.Exists(VisibilityPath) || File.ReadAllText(VisibilityPath).Trim() != "hidden";
        }
        catch
        {
            return true;
        }
    }

    public static async Task EnsureLoadedAsync()
    {
        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_loaded) return;
            Books = await Bridge.GetAsync<List<BookItem>>("/v1/books").ConfigureAwait(false);
            CurrentBook = Books.FirstOrDefault() ?? throw new InvalidOperationException("桌面端书库中还没有小说");
            await LoadBookCoreAsync(CurrentBook).ConfigureAwait(false);
            _loaded = true;
        }
        finally
        {
            Gate.Release();
        }
        RaiseChanged();
    }

    public static async Task SelectBookAsync(BookItem book)
    {
        if (book == null) return;
        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            await SaveProgressAsync().ConfigureAwait(false);
            CurrentBook = book;
            await LoadBookCoreAsync(book).ConfigureAwait(false);
            _loaded = true;
        }
        finally
        {
            Gate.Release();
        }
        RaiseChanged();
    }

    public static async Task SelectChapterAsync(ChapterItem chapter)
    {
        if (chapter == null) return;
        await EnsureLoadedAsync().ConfigureAwait(false);
        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (CurrentBook == null) return;
            await LoadReadableChapterAsync(chapter.Number, 1).ConfigureAwait(false);
        }
        finally
        {
            Gate.Release();
        }
        RaiseChanged();
    }

    public static async Task MoveLineAsync(int direction)
    {
        await EnsureLoadedAsync().ConfigureAwait(false);
        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (direction == 0 || CurrentChapter == null || _lines.Count == 0) return;
            var maximumStart = Math.Max(0, _lines.Count - 5);
            var nextLineStart = _lineStart + direction;
            if (nextLineStart < 0 || nextLineStart > maximumStart)
            {
                var nextChapterIndex = CurrentChapterIndex + (direction > 0 ? 1 : -1);
                if (nextChapterIndex < 0 || nextChapterIndex >= Chapters.Count) return;
                var changed = await LoadReadableChapterAsync(
                    Chapters[nextChapterIndex].Number,
                    direction,
                    startAtEnd: direction < 0,
                    keepCurrentOnEmpty: true).ConfigureAwait(false);
                if (changed) RaiseChanged();
                return;
            }
            _lineStart = nextLineStart;
            RaiseChanged();
            await SaveProgressAsync().ConfigureAwait(false);
        }
        finally
        {
            Gate.Release();
        }
    }

    public static async Task MoveChapterAsync(int direction)
    {
        await EnsureLoadedAsync().ConfigureAwait(false);
        await Gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (CurrentChapter == null) return;
            var index = Chapters.ToList().FindIndex(item => item.Number == CurrentChapter.Number);
            var next = Math.Max(0, Math.Min(Chapters.Count - 1, index + direction));
            if (next != index)
            {
                await LoadReadableChapterAsync(Chapters[next].Number, direction).ConfigureAwait(false);
                RaiseChanged();
            }
        }
        finally
        {
            Gate.Release();
        }
    }

    private static async Task LoadBookCoreAsync(BookItem book)
    {
        var latestBook = await Bridge.GetAsync<BookItem>(
            $"/v1/books/{Uri.EscapeDataString(book.Id)}").ConfigureAwait(false);
        if (latestBook != null)
        {
            book.CurrentChapter = latestBook.CurrentChapter;
            book.ChapterProgress = latestBook.ChapterProgress;
        }
        CurrentBook = book;
        var allChapters = await Bridge.GetAsync<List<ChapterItem>>(
            $"/v1/books/{Uri.EscapeDataString(book.Id)}/chapters").ConfigureAwait(false);
        var readableChapters = allChapters.Where(item => string.IsNullOrEmpty(item.Kind) || item.Kind == "chapter").ToList();
        Chapters = readableChapters.Count > 0 ? readableChapters : allChapters;
        for (var index = 0; index < Chapters.Count; index++) Chapters[index].Ordinal = index + 1;
        var preferred = Chapters.FirstOrDefault(item => item.Number == book.CurrentChapter)
            ?? Chapters.FirstOrDefault()
            ?? throw new InvalidOperationException("当前小说没有章节");
        await LoadReadableChapterAsync(preferred.Number, 1, book.ChapterProgress).ConfigureAwait(false);
    }

    private static async Task<bool> LoadReadableChapterAsync(
        int chapterNumber,
        int direction,
        double? restoredProgress = null,
        bool startAtEnd = false,
        bool keepCurrentOnEmpty = false)
    {
        if (CurrentBook == null) return false;
        var index = Chapters.ToList().FindIndex(item => item.Number == chapterNumber);
        for (var attempts = 0; index >= 0 && index < Chapters.Count && attempts < 30; attempts++, index += direction)
        {
            var chapter = await Bridge.GetAsync<ChapterPayload>(
                $"/v1/books/{Uri.EscapeDataString(CurrentBook.Id)}/chapters/{Chapters[index].Number}").ConfigureAwait(false);
            var lines = SplitLines(string.IsNullOrWhiteSpace(chapter.ContentText) ? chapter.Content : chapter.ContentText);
            if (lines.Count == 0) continue;
            CurrentChapter = chapter;
            _lines = lines;
            var maximumStart = Math.Max(0, lines.Count - 5);
            _lineStart = chapter.Number == chapterNumber && restoredProgress.HasValue
                ? LineStartFromProgress(lines.Count, restoredProgress.Value)
                : startAtEnd ? maximumStart : 0;
            await SaveProgressAsync().ConfigureAwait(false);
            return true;
        }
        if (keepCurrentOnEmpty) return false;
        throw new InvalidOperationException("附近没有可阅读的正文章节");
    }

    private static int LineStartFromProgress(int lineCount, double progress)
    {
        var maximumStart = Math.Max(0, lineCount - 5);
        var normalized = Math.Max(0d, Math.Min(100d, progress));
        return Math.Max(0, Math.Min(maximumStart, (int)Math.Round(maximumStart * normalized / 100d)));
    }

    private static async Task SaveProgressAsync()
    {
        if (CurrentBook == null || CurrentChapter == null || _lines.Count == 0) return;
        var chapterNumber = CurrentChapter.Number;
        var chapterProgress = ChapterProgress;
        CurrentBook.CurrentChapter = chapterNumber;
        CurrentBook.ChapterProgress = chapterProgress;
        await Bridge.PostAsync("/v1/progress", new
        {
            bookId = CurrentBook.Id,
            chapterNumber,
            chapterProgress
        }).ConfigureAwait(false);
    }

    private static List<string> SplitLines(string text)
    {
        var result = new List<string>();
        foreach (var paragraph in (text ?? "").Replace("\r", "").Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var line = "";
            foreach (var character in paragraph.Trim())
            {
                line += character;
                if (line.Length >= 42 || (line.Length >= 18 && "，。！？；：、,.!?;:".Contains(character)))
                {
                    result.Add(line);
                    line = "";
                }
            }
            if (line.Length > 0) result.Add(line);
        }
        return result;
    }

    private static void RaiseChanged() => Changed?.Invoke(null, EventArgs.Empty);
}
