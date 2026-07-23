using System;
using System.ComponentModel.Design;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace NovelLibrary.VisualStudio;

internal sealed class NovelLibraryCommands
{
    public static readonly Guid CommandSet = new Guid("78D2C158-34C0-4B78-96AA-119AF61884B7");
    private readonly AsyncPackage _package;

    private NovelLibraryCommands(AsyncPackage package, OleMenuCommandService commands)
    {
        _package = package;
        Add(commands, 0x0100, pane => Task.CompletedTask);
        Add(commands, 0x0101, pane => NovelLibraryReaderSession.MoveLineAsync(-1));
        Add(commands, 0x0102, pane => NovelLibraryReaderSession.MoveLineAsync(1));
        Add(commands, 0x0103, pane => NovelLibraryReaderSession.MoveChapterAsync(-1));
        Add(commands, 0x0104, pane => NovelLibraryReaderSession.MoveChapterAsync(1));
        commands.AddCommand(new MenuCommand(
            (_, __) => NovelLibraryReaderSession.ToggleVisibility(),
            new CommandID(CommandSet, 0x0105)));
        commands.AddCommand(new MenuCommand(
            (_, __) => ShortcutHelp.Show(),
            new CommandID(CommandSet, 0x0106)));
        commands.AddCommand(new MenuCommand(
            (_, __) => NovelLibraryReaderSession.ToggleDisplayMode(),
            new CommandID(CommandSet, 0x0107)));
    }

    public static async Task InitializeAsync(AsyncPackage package)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var service = await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
        if (service != null) _ = new NovelLibraryCommands(package, service);
    }

    private void Add(OleMenuCommandService commands, int id, Func<NovelLibraryToolWindow, Task> action)
    {
        commands.AddCommand(new MenuCommand((_, __) =>
            _ = _package.JoinableTaskFactory.RunAsync(async () =>
            {
                var pane = await _package.ShowToolWindowAsync(
                    typeof(NovelLibraryToolWindow), 0, true, _package.DisposalToken) as NovelLibraryToolWindow;
                if (pane != null) await action(pane);
            }), new CommandID(CommandSet, id)));
    }
}
