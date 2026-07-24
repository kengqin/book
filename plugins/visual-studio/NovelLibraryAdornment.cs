using System;
using System.Collections.Generic;
using System.Linq;
using System.ComponentModel.Composition;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.Utilities;

namespace NovelLibrary.VisualStudio;

internal static class NovelLibraryAdornmentLayer
{
    public const string Name = "NovelLibraryInlineReader";
}

[Export(typeof(IWpfTextViewCreationListener))]
[ContentType("text")]
[TextViewRole(PredefinedTextViewRoles.Document)]
internal sealed class NovelLibraryAdornmentFactory : IWpfTextViewCreationListener
{
#pragma warning disable 0169, 0649
    [Export(typeof(AdornmentLayerDefinition))]
    [Name(NovelLibraryAdornmentLayer.Name)]
    [Order(After = PredefinedAdornmentLayers.Text)]
    private AdornmentLayerDefinition _layerDefinition;
#pragma warning restore 0169, 0649

    public void TextViewCreated(IWpfTextView textView) => _ = new NovelLibraryAdornment(textView);
}

internal sealed class NovelLibraryAdornment
{
    private static readonly bool InlineChapterControlsEnabled = false;
    private readonly IWpfTextView _view;
    private readonly IAdornmentLayer _layer;
    private readonly List<Rect> _readerRegions = new List<Rect>();

    public NovelLibraryAdornment(IWpfTextView view)
    {
        _view = view;
        _layer = view.GetAdornmentLayer(NovelLibraryAdornmentLayer.Name);
        _view.LayoutChanged += (_, __) => Render();
        _view.Caret.PositionChanged += (_, __) => Render();
        _view.VisualElement.PreviewMouseWheel += OnPreviewMouseWheel;
        _view.Closed += OnClosed;
        NovelLibraryReaderSession.Changed += OnReaderChanged;
        _ = LoadAsync();
    }

    private async System.Threading.Tasks.Task LoadAsync()
    {
        try { await NovelLibraryReaderSession.EnsureLoadedAsync(); }
        catch { }
        ScheduleRender();
    }

    private void OnReaderChanged(object sender, EventArgs args) => ScheduleRender();

    private void OnClosed(object sender, EventArgs args)
    {
        NovelLibraryReaderSession.Changed -= OnReaderChanged;
        _view.VisualElement.PreviewMouseWheel -= OnPreviewMouseWheel;
    }

    private void OnPreviewMouseWheel(object sender, MouseWheelEventArgs args)
    {
        if (!NovelLibraryReaderSession.IsReaderVisible || Keyboard.Modifiers != ModifierKeys.None) return;
        var viewportPoint = args.GetPosition(_view.VisualElement);
        var point = new Point(
            viewportPoint.X + _view.ViewportLeft,
            viewportPoint.Y + _view.ViewportTop);
        if (!_readerRegions.Any(region => region.Contains(point))) return;
        args.Handled = true;
        _ = NovelLibraryReaderSession.MoveLineAsync(args.Delta < 0 ? 1 : -1);
    }

    private void ScheduleRender() => ThreadHelper.JoinableTaskFactory.Run(async () =>
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        Render();
    });

    private void Render()
    {
        if (_view.IsClosed) return;
        _layer.RemoveAllAdornments();
        _readerRegions.Clear();
        if (!NovelLibraryReaderSession.IsReaderVisible) return;
        var lines = NovelLibraryReaderSession.VisibleLines;
        if (NovelLibraryReaderSession.CurrentChapter == null || _view.TextSnapshot.LineCount == 0) return;

        var contentCount = Math.Min(5, Math.Min(lines.Count, Math.Max(0, _view.TextSnapshot.LineCount - 1)));
        var count = contentCount + 1;
        var caretLine = _view.Caret.Position.BufferPosition.GetContainingLine().LineNumber;
        var firstLine = Math.Min(caretLine, Math.Max(0, _view.TextSnapshot.LineCount - count));
        var paragraphMode = NovelLibraryReaderSession.DisplayMode == ReaderDisplayMode.Paragraph;
        var headerSnapshotLine = _view.TextSnapshot.GetLineFromLineNumber(firstLine);
        var headerViewLine = _view.GetTextViewLineContainingBufferPosition(headerSnapshotLine.Start);
        if (headerViewLine != null && headerViewLine.IsValid)
        {
            AddHeaderAdornment(headerViewLine, paragraphMode);
        }

        for (var index = 0; index < contentCount; index++)
        {
            var snapshotLine = _view.TextSnapshot.GetLineFromLineNumber(firstLine + index + 1);
            var viewLine = _view.GetTextViewLineContainingBufferPosition(snapshotLine.Start);
            if (viewLine == null || !viewLine.IsValid) continue;
            var properties = _view.FormattedLineSource.DefaultTextProperties;
            var label = new TextBlock
            {
                Text = paragraphMode ? lines[index] : $"  // {lines[index]}",
                FontFamily = paragraphMode ? properties.Typeface.FontFamily : new FontFamily("Consolas"),
                FontSize = paragraphMode ? properties.FontRenderingEmSize : 13,
                FontStyle = paragraphMode ? FontStyles.Normal : FontStyles.Italic,
                Foreground = paragraphMode
                    ? properties.ForegroundBrush
                    : new SolidColorBrush(Color.FromRgb(128, 136, 148)),
                IsHitTestVisible = false
            };
            FrameworkElement adornment = label;
            double left;
            if (paragraphMode)
            {
                var width = Math.Max(220, Math.Min(_view.ViewportWidth * 0.72, _view.ViewportWidth - 32));
                adornment = new Border
                {
                    Width = width,
                    Height = viewLine.Height,
                    Background = _view.Background,
                    Padding = new Thickness(12, 0, 8, 0),
                    Child = label,
                    IsHitTestVisible = false
                };
                left = _view.ViewportLeft + 12;
                _readerRegions.Add(new Rect(left, viewLine.Top, width, viewLine.Height));
            }
            else
            {
                left = Math.Max(viewLine.TextRight + 24, _view.ViewportLeft + _view.ViewportWidth * 0.5);
                label.Measure(new Size(double.PositiveInfinity, viewLine.Height));
                _readerRegions.Add(new Rect(left, viewLine.Top, label.DesiredSize.Width, viewLine.Height));
            }
            Canvas.SetLeft(adornment, left);
            Canvas.SetTop(adornment, viewLine.Top);
            _layer.AddAdornment(AdornmentPositioningBehavior.ViewportRelative, null, null, adornment, null);
        }
    }

    private void AddHeaderAdornment(ITextViewLine viewLine, bool paragraphMode)
    {
        var properties = _view.FormattedLineSource.DefaultTextProperties;
        var text = new TextBlock
        {
            Text = paragraphMode ? NovelLibraryReaderSession.Header : $"  // {NovelLibraryReaderSession.Header}",
            FontFamily = paragraphMode ? properties.Typeface.FontFamily : new FontFamily("Consolas"),
            FontSize = paragraphMode ? properties.FontRenderingEmSize : 13,
            FontWeight = FontWeights.SemiBold,
            Foreground = paragraphMode
                ? properties.ForegroundBrush
                : new SolidColorBrush(Color.FromRgb(128, 136, 148)),
            VerticalAlignment = VerticalAlignment.Center,
            TextTrimming = TextTrimming.CharacterEllipsis
        };
        var panel = new DockPanel { Height = viewLine.Height };
        if (InlineChapterControlsEnabled)
        {
            var navigation = new StackPanel { Orientation = Orientation.Horizontal };
            navigation.Children.Add(CreateChapterButton("上一章", -1, NovelLibraryReaderSession.HasPreviousChapter, viewLine.Height));
            navigation.Children.Add(CreateChapterButton("下一章", 1, NovelLibraryReaderSession.HasNextChapter, viewLine.Height));
            DockPanel.SetDock(navigation, Dock.Right);
            panel.Children.Add(navigation);
        }
        panel.Children.Add(text);

        FrameworkElement adornment = panel;
        double left;
        double width;
        if (paragraphMode)
        {
            width = Math.Max(260, Math.Min(_view.ViewportWidth * 0.82, _view.ViewportWidth - 32));
            adornment = new Border
            {
                Width = width,
                Height = viewLine.Height,
                Background = _view.Background,
                Padding = new Thickness(12, 0, 8, 0),
                Child = panel
            };
            left = _view.ViewportLeft + 12;
        }
        else
        {
            left = Math.Max(viewLine.TextRight + 24, _view.ViewportLeft + _view.ViewportWidth * 0.5);
            panel.Measure(new Size(double.PositiveInfinity, viewLine.Height));
            width = panel.DesiredSize.Width;
        }
        _readerRegions.Add(new Rect(left, viewLine.Top, width, viewLine.Height));
        Canvas.SetLeft(adornment, left);
        Canvas.SetTop(adornment, viewLine.Top);
        _layer.AddAdornment(AdornmentPositioningBehavior.ViewportRelative, null, null, adornment, null);
    }

    private static Button CreateChapterButton(string label, int direction, bool enabled, double height)
    {
        var button = new Button
        {
            Content = label,
            IsEnabled = enabled,
            Height = height,
            Margin = new Thickness(6, 0, 0, 0),
            Padding = new Thickness(5, 0, 5, 0),
            FontSize = 11,
            VerticalAlignment = VerticalAlignment.Center
        };
        button.Click += (_, __) => _ = NovelLibraryReaderSession.MoveChapterAsync(direction);
        return button;
    }
}
