using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.Shell;

namespace NovelLibrary.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("Novel Library Reader", "Read local novels while coding", "0.4.0")]
[Guid("A6EAFB7B-4A30-4EAA-9B0B-B8A8DEBA6E30")]
public sealed class NovelLibraryPackage : AsyncPackage
{
    protected override Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
        => Task.CompletedTask;
}
