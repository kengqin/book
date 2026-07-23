using System;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
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
        AddButton(toolbar, "上一章", () => NovelLibraryReaderSession.MoveChapterAsync(-1));
        AddButton(toolbar, "下一章", () => NovelLibraryReaderSession.MoveChapterAsync(1));
        AddButton(toolbar, "上一行", () => NovelLibraryReaderSession.MoveLineAsync(-1));
        AddButton(toolbar, "下一行", () => NovelLibraryReaderSession.MoveLineAsync(1));
        _displayMode.Click += (_, __) => NovelLibraryReaderSession.ToggleDisplayMode();
        toolbar.Children.Add(_displayMode);
        _readerVisibility.Click += (_, __) => NovelLibraryReaderSession.ToggleVisibility();
        toolbar.Children.Add(_readerVisibility);
        var shortcuts = new Button { Content = "快捷键", Margin = new Thickness(0, 0, 6, 4), Padding = new Thickness(8, 3, 8, 3) };
        shortcuts.Click += (_, __) => ShortcutHelp.Show();
        toolbar.Children.Add(shortcuts);
        DockPanel.SetDock(toolbar, Dock.Top);
        DockPanel.SetDock(_status, Dock.Bottom);
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

    private async Task RunAsync(Func<Task> action)
    {
        try
        {
            _status.Text = "正在连接小说书库桌面端...";
            await action();
            Refresh();
        }
        catch (Exception error)
        {
            _status.Text = $"连接失败：{error.Message}";
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
        _displayMode.Content = NovelLibraryReaderSession.DisplayModeLabel;
        _readerVisibility.Content = NovelLibraryReaderSession.VisibilityLabel;
        _status.Text = NovelLibraryReaderSession.Status;
        _refreshing = false;
    }
}

internal static class ShortcutHelp
{
    private const string Content =
        "Ctrl+Alt+N    开启或关闭代码内阅读\n" +
        "Ctrl+Alt+9    切换段落/行尾显示模式\n" +
        "Ctrl+Alt+↑    上一行\n" +
        "Ctrl+Alt+↓    下一行\n" +
        "Ctrl+Alt+←    上一章\n" +
        "Ctrl+Alt+→    下一章";

    internal static void Show() => MessageBox.Show(
        Content,
        "小说书库快捷键",
        MessageBoxButton.OK,
        MessageBoxImage.Information);
}
