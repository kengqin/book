using System;
using System.ComponentModel.Composition;
using System.Windows;
using System.Windows.Controls;
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
    private readonly IWpfTextView _view;
    private readonly IAdornmentLayer _layer;

    public NovelLibraryAdornment(IWpfTextView view)
    {
        _view = view;
        _layer = view.GetAdornmentLayer(NovelLibraryAdornmentLayer.Name);
        _view.LayoutChanged += (_, __) => Render();
        _view.Caret.PositionChanged += (_, __) => Render();
        _view.Closed += (_, __) => NovelLibraryReaderSession.Changed -= OnReaderChanged;
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

    private void ScheduleRender() => ThreadHelper.JoinableTaskFactory.Run(async () =>
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        Render();
    });

    private void Render()
    {
        if (_view.IsClosed) return;
        _layer.RemoveAllAdornments();
        if (!NovelLibraryReaderSession.IsReaderVisible) return;
        var lines = NovelLibraryReaderSession.VisibleLines;
        if (lines.Count == 0 || _view.TextSnapshot.LineCount == 0) return;

        var count = Math.Min(5, Math.Min(lines.Count, _view.TextSnapshot.LineCount));
        var caretLine = _view.Caret.Position.BufferPosition.GetContainingLine().LineNumber;
        var firstLine = Math.Min(caretLine, Math.Max(0, _view.TextSnapshot.LineCount - count));
        var paragraphMode = NovelLibraryReaderSession.DisplayMode == ReaderDisplayMode.Paragraph;
        for (var index = 0; index < count; index++)
        {
            var snapshotLine = _view.TextSnapshot.GetLineFromLineNumber(firstLine + index);
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
            if (paragraphMode)
            {
                adornment = new Border
                {
                    Width = Math.Max(220, Math.Min(_view.ViewportWidth * 0.72, _view.ViewportWidth - 32)),
                    Height = viewLine.Height,
                    Background = _view.Background,
                    Padding = new Thickness(12, 0, 8, 0),
                    Child = label,
                    IsHitTestVisible = false
                };
                Canvas.SetLeft(adornment, _view.ViewportLeft + 12);
            }
            else
            {
                Canvas.SetLeft(adornment, Math.Max(viewLine.TextRight + 24, _view.ViewportLeft + _view.ViewportWidth * 0.5));
            }
            Canvas.SetTop(adornment, viewLine.Top);
            _layer.AddAdornment(AdornmentPositioningBehavior.ViewportRelative, null, null, adornment, null);
        }
    }
}
