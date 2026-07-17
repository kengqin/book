using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace NovelLibrary.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("小说书库阅读器", "在 Visual Studio 代码中阅读本地小说", "0.4.0")]
[ProvideMenuResource("Menus.ctmenu", 1)]
[ProvideToolWindow(typeof(NovelLibraryToolWindow))]
[Guid(PackageGuidString)]
public sealed class NovelLibraryPackage : AsyncPackage
{
    public const string PackageGuidString = "A6EAFB7B-4A30-4EAA-9B0B-B8A8DEBA6E30";

    protected override async Task InitializeAsync(
        CancellationToken cancellationToken,
        IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        await NovelLibraryCommands.InitializeAsync(this);
    }
}
