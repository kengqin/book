using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Forms = System.Windows.Forms;
using Microsoft.VisualStudio.Shell;

namespace NovelLibrary.VisualStudio;

public sealed class NovelLibraryToolWindow : ToolWindowPane
{
    internal NovelLibraryReaderControl ReaderControl { get; }

    public NovelLibraryToolWindow() : base(null)
    {
        Caption = "小说书库";
        ReaderControl = new NovelLibraryReaderControl();
        Content = ReaderControl;
    }
}

internal sealed class NovelLibraryReaderControl : UserControl
{
    private readonly ComboBox _books = new ComboBox { MinWidth = 140, Margin = new Thickness(0, 0, 6, 0) };
    private readonly ComboBox _chapters = new ComboBox { MinWidth = 160, Margin = new Thickness(0, 0, 6, 0) };
    private readonly TextBlock _content = new TextBlock
    {
        TextWrapping = TextWrapping.Wrap,
        FontFamily = new FontFamily("Consolas"),
        FontSize = 14,
        Margin = new Thickness(10)
    };
    private readonly TextBlock _chapterInfo = new TextBlock
    {
        Margin = new Thickness(8, 5, 8, 5),
        FontWeight = FontWeights.SemiBold,
        VerticalAlignment = VerticalAlignment.Center,
        TextTrimming = TextTrimming.CharacterEllipsis
    };
    private readonly Button _previousChapter = new Button { Content = "上一章", Margin = new Thickness(0, 2, 6, 2), Padding = new Thickness(8, 3, 8, 3) };
    private readonly Button _nextChapter = new Button { Content = "下一章", Margin = new Thickness(0, 2, 0, 2), Padding = new Thickness(8, 3, 8, 3) };
    private readonly TextBlock _status = new TextBlock { Margin = new Thickness(8, 4, 8, 6) };
    private readonly ScrollViewer _contentScroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    private readonly Button _displayMode = new Button { Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
    private readonly Button _readerVisibility = new Button { Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
    private bool _refreshing;

    public NovelLibraryReaderControl()
    {
        var root = new DockPanel();
        var toolbar = new WrapPanel { Margin = new Thickness(8, 8, 8, 4) };
        toolbar.Children.Add(_books);
        toolbar.Children.Add(_chapters);
        AddButton(toolbar, "上一行", () => NovelLibraryReaderSession.MoveLineAsync(-1));
        AddButton(toolbar, "下一行", () => NovelLibraryReaderSession.MoveLineAsync(1));
        var libraryMode = new Button { Content = NovelLibraryLocalSettings.UseDesktopLibrary ? "桌面书库" : "本地书库", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        libraryMode.Click += (_, __) => _ = SwitchLibraryModeAsync(libraryMode);
        toolbar.Children.Add(libraryMode);
        var localDirectory = new Button { Content = "本地目录", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        localDirectory.Click += (_, __) => _ = ConfigureLocalDirectoryAsync(libraryMode);
        toolbar.Children.Add(localDirectory);
        var importFile = new Button { Content = "导入小说", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        importFile.Click += (_, __) => _ = ImportFileAsync();
        toolbar.Children.Add(importFile);
        var backup = new Button { Content = "备份", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        backup.Click += (_, __) => _ = BackupLibraryAsync();
        toolbar.Children.Add(backup);
        var restore = new Button { Content = "恢复", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        restore.Click += (_, __) => _ = RestoreLibraryAsync();
        toolbar.Children.Add(restore);
        var reparse = new Button { Content = "重新解析", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        reparse.Click += (_, __) => _ = ReparseCurrentBookAsync();
        toolbar.Children.Add(reparse);
        var deleteBook = new Button { Content = "删除", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        deleteBook.Click += (_, __) => _ = DeleteCurrentBookAsync();
        toolbar.Children.Add(deleteBook);
        var diagnostics = new Button { Content = "诊断", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        diagnostics.Click += (_, __) => _ = ShowDiagnosticsAsync();
        toolbar.Children.Add(diagnostics);
        _displayMode.Click += (_, __) => NovelLibraryReaderSession.ToggleDisplayMode();
        toolbar.Children.Add(_displayMode);
        _readerVisibility.Click += (_, __) => NovelLibraryReaderSession.ToggleVisibility();
        toolbar.Children.Add(_readerVisibility);
        var shortcuts = new Button { Content = "快捷键", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        shortcuts.Click += (_, __) => ShortcutHelp.Show();
        toolbar.Children.Add(shortcuts);
        var configureShortcuts = new Button { Content = "自定义快捷键", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        configureShortcuts.Click += (_, __) =>
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            ShortcutHelp.OpenKeyboardSettings();
        };
        toolbar.Children.Add(configureShortcuts);
        _previousChapter.Click += (_, __) => _ = RunAsync(() => NovelLibraryReaderSession.MoveChapterAsync(-1));
        _nextChapter.Click += (_, __) => _ = RunAsync(() => NovelLibraryReaderSession.MoveChapterAsync(1));
        _previousChapter.IsEnabled = false;
        _nextChapter.IsEnabled = false;
        var chapterNavigation = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 8, 0) };
        chapterNavigation.Children.Add(_previousChapter);
        chapterNavigation.Children.Add(_nextChapter);
        var chapterHeader = new DockPanel();
        DockPanel.SetDock(chapterNavigation, Dock.Right);
        chapterHeader.Children.Add(chapterNavigation);
        chapterHeader.Children.Add(_chapterInfo);
        DockPanel.SetDock(chapterHeader, Dock.Top);
        DockPanel.SetDock(toolbar, Dock.Top);
        DockPanel.SetDock(_status, Dock.Bottom);
        root.Children.Add(chapterHeader);
        root.Children.Add(toolbar);
        root.Children.Add(_status);
        _contentScroll.Content = _content;
        _contentScroll.PreviewMouseWheel += (_, args) =>
        {
            if (!NovelLibraryReaderSession.IsReaderVisible || Keyboard.Modifiers != ModifierKeys.None) return;
            args.Handled = true;
            _ = RunAsync(() => NovelLibraryReaderSession.MoveLineAsync(args.Delta < 0 ? 1 : -1));
        };
        root.Children.Add(_contentScroll);
        Content = root;

        _books.SelectionChanged += (_, __) =>
        {
            if (!_refreshing && _books.SelectedItem is BookItem book)
                _ = RunAsync(() => NovelLibraryReaderSession.SelectBookAsync(book));
        };
        _chapters.SelectionChanged += (_, __) =>
        {
            if (!_refreshing && _chapters.SelectedItem is ChapterItem chapter)
                _ = RunAsync(() => NovelLibraryReaderSession.SelectChapterAsync(chapter));
        };
        NovelLibraryReaderSession.Changed += (_, __) => ScheduleRefresh();
        Loaded += (_, __) => _ = RunAsync(NovelLibraryReaderSession.EnsureLoadedAsync);
    }

    private void AddButton(Panel panel, string label, Func<Task> action)
    {
        var button = new Button { Content = label, Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        button.Click += (_, __) => _ = RunAsync(action);
        panel.Children.Add(button);
    }

    private async Task SwitchLibraryModeAsync(Button libraryMode)
    {
        try
        {
            var next = !NovelLibraryLocalSettings.UseDesktopLibrary;
            var title = next ? "桌面书库" : "本地书库";
            if (MessageBox.Show($"切换后使用{title}；当前数据不会自动复制。", "小说书库数据源", MessageBoxButton.YesNo, MessageBoxImage.Question) != MessageBoxResult.Yes) return;
            try { await NovelLibraryReaderSession.FlushProgressAsync(); } catch { }
            NovelLibraryLocalSettings.SetUseDesktopLibrary(next);
            libraryMode.Content = title;
            NovelLibraryReaderSession.ResetForProviderSwitch();
            await RunAsync(NovelLibraryReaderSession.EnsureLoadedAsync);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "小说书库数据源", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task ConfigureLocalDirectoryAsync(Button libraryMode)
    {
        using (var dialog = new Forms.FolderBrowserDialog { SelectedPath = NovelLibraryLocalSettings.LocalDataDirectory, Description = "选择小说书库本地数据目录" })
        {
            if (dialog.ShowDialog() != Forms.DialogResult.OK) return;
            try
            {
                var current = NovelLibraryLocalSettings.LocalDataDirectory;
                try { await NovelLibraryReaderSession.FlushProgressAsync(); } catch { }
                var migrationLock = NovelLibraryLocalSettings.BeginMigration(current);
                try
                {
                    await NovelLibraryBridge.ShutdownLocalRuntimeAsync();
                    await Task.Run(() => NovelLibraryLocalSettings.SetLocalDataDirectory(dialog.SelectedPath, current));
                }
                finally
                {
                    NovelLibraryLocalSettings.EndMigration(migrationLock);
                }
                NovelLibraryReaderSession.ResetForProviderSwitch();
                libraryMode.Content = "本地书库";
                await RunAsync(NovelLibraryReaderSession.EnsureLoadedAsync);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "小说书库本地目录", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }
    }

    private async Task ImportFileAsync()
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            MessageBox.Show("请先切换到本地书库；桌面模式请在小说书库桌面端中导入。", "导入小说", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "导入 TXT 或 EPUB 小说",
            Filter = "小说文件 (*.txt;*.epub)|*.txt;*.epub|TXT 文件 (*.txt)|*.txt|EPUB 文件 (*.epub)|*.epub",
            Multiselect = false
        };
        if (dialog.ShowDialog() == true)
            await RunAsync(() => NovelLibraryReaderSession.ImportFileAsync(dialog.FileName));
    }

    private async Task BackupLibraryAsync()
    {
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "备份当前小说书库",
            Filter = "小说书库备份 (*.json)|*.json|所有文件 (*.*)|*.*",
            FileName = $"novel-library-backup-{DateTime.Now:yyyyMMdd-HHmmss}.json",
            AddExtension = true,
            DefaultExt = ".json"
        };
        if (dialog.ShowDialog() == true)
        {
            if (await RunAsync(() => NovelLibraryReaderSession.BackupLibraryAsync(dialog.FileName)))
                MessageBox.Show("书库备份完成", "小说书库", MessageBoxButton.OK, MessageBoxImage.Information);
        }
    }

    private async Task RestoreLibraryAsync()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "恢复或迁移小说书库",
            Filter = "小说书库备份 (*.json;*.novellibrary-backup;*.novellibrary-transfer)|*.json;*.novellibrary-backup;*.novellibrary-transfer|所有文件 (*.*)|*.*"
        };
        if (dialog.ShowDialog() != true) return;
        var strategy = "merge";
        if (!NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            var choice = MessageBox.Show(
                "选择“是”将清空本地书库并恢复（会先自动备份）；选择“否”将合并恢复。",
                "恢复小说书库",
                MessageBoxButton.YesNoCancel,
                MessageBoxImage.Warning);
            if (choice == MessageBoxResult.Cancel) return;
            strategy = choice == MessageBoxResult.Yes ? "replace" : "merge";
        }
        else if (MessageBox.Show("备份内容将合并到当前桌面书库，是否继续？", "恢复小说书库", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes)
        {
            return;
        }
        if (await RunAsync(() => NovelLibraryReaderSession.RestoreLibraryAsync(dialog.FileName, strategy)))
            MessageBox.Show("书库恢复完成", "小说书库", MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private async Task ReparseCurrentBookAsync()
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            MessageBox.Show("重新解析仅适用于本地书库", "小说书库", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        await RunAsync(NovelLibraryReaderSession.ReparseCurrentBookAsync);
    }

    private async Task DeleteCurrentBookAsync()
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            MessageBox.Show("删除书籍请在桌面端中操作", "小说书库", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        var book = NovelLibraryReaderSession.CurrentBook;
        if (book == null) return;
        if (MessageBox.Show($"确定删除《{book.Title}》及其受管源文件吗？", "删除本地书籍", MessageBoxButton.YesNo, MessageBoxImage.Warning) == MessageBoxResult.Yes)
            await RunAsync(NovelLibraryReaderSession.DeleteCurrentBookAsync);
    }

    private async Task ShowDiagnosticsAsync()
    {
        if (NovelLibraryLocalSettings.UseDesktopLibrary)
        {
            MessageBox.Show("Runtime 诊断仅适用于本地书库", "小说书库", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        try
        {
            var diagnostics = await NovelLibraryReaderSession.GetDiagnosticsAsync();
            MessageBox.Show(diagnostics, "小说书库 Runtime 诊断", MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "小说书库 Runtime 诊断", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task<bool> RunAsync(Func<Task> action)
    {
        try
        {
            _status.Text = NovelLibraryLocalSettings.UseDesktopLibrary
                ? "正在连接小说书库桌面端..."
                : "正在连接小说书库本地 Runtime...";
            await action();
            Refresh();
            return true;
        }
        catch (Exception error)
        {
            _status.Text = $"连接失败：{error.Message}";
            return false;
        }
    }

    private void ScheduleRefresh() => ThreadHelper.JoinableTaskFactory.Run(async () =>
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        Refresh();
    });

    private void Refresh()
    {
        _refreshing = true;
        _books.ItemsSource = NovelLibraryReaderSession.Books;
        _chapters.ItemsSource = NovelLibraryReaderSession.Chapters;
        _books.SelectedItem = NovelLibraryReaderSession.CurrentBook;
        if (NovelLibraryReaderSession.CurrentChapter != null)
        {
            foreach (ChapterItem chapter in _chapters.Items)
            {
                if (chapter.Number == NovelLibraryReaderSession.CurrentChapter.Number) _chapters.SelectedItem = chapter;
            }
        }
        _content.Text = string.Join(Environment.NewLine, NovelLibraryReaderSession.VisibleLines);
        _chapterInfo.Text = NovelLibraryReaderSession.Header;
        _previousChapter.IsEnabled = NovelLibraryReaderSession.HasPreviousChapter;
        _nextChapter.IsEnabled = NovelLibraryReaderSession.HasNextChapter;
        _displayMode.Content = NovelLibraryReaderSession.DisplayModeLabel;
        _readerVisibility.Content = NovelLibraryReaderSession.VisibilityLabel;
        _status.Text = NovelLibraryReaderSession.Status;
        _refreshing = false;
    }
}

internal static class ShortcutHelp
{
    private const string Content =
        "以下为默认键位，用户设置优先：\n\n" +
        "Ctrl+Alt+N    开启或关闭代码内阅读\n" +
        "Ctrl+Alt+9    切换段落/行尾显示模式\n" +
        "Ctrl+Alt+↑    上一行\n" +
        "Ctrl+Alt+↓    下一行\n" +
        "Ctrl+Alt+←    上一章\n" +
        "Ctrl+Alt+→    下一章\n\n" +
        "可在 工具 → 选项 → 环境 → 键盘 中为“小说书库”命令重新绑定。";

    internal static void Show() => MessageBox.Show(
        Content,
        "小说书库快捷键",
        MessageBoxButton.OK,
        MessageBoxImage.Information);

    internal static void OpenKeyboardSettings()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        var dte = Package.GetGlobalService(typeof(EnvDTE.DTE)) as EnvDTE.DTE;
        if (dte == null)
        {
            MessageBox.Show("请打开 工具 → 选项 → 环境 → 键盘，并搜索“小说书库”命令。", "自定义快捷键");
            return;
        }
        try
        {
            dte.ExecuteCommand("Tools.Options", "Environment.Keyboard");
        }
        catch
        {
            MessageBox.Show("请打开 工具 → 选项 → 环境 → 键盘，并搜索“小说书库”命令。", "自定义快捷键");
        }
    }
}
