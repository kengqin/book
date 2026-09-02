using System;
using System.ComponentModel;
using Microsoft.VisualStudio.Shell;

namespace NovelLibrary.VisualStudio;

public sealed class NovelLibraryOptionsPage : DialogPage
{
    [Category("书库来源")]
    [DisplayName("使用桌面端书库")]
    [Description("开启后连接桌面端书库；关闭后由插件维护独立本地书库。")]
    public bool UseDesktopLibrary { get; set; } = NovelLibraryLocalSettings.UseDesktopLibrary;

    [Category("本地 Runtime")]
    [DisplayName("本地书库数据目录")]
    [Description("本地模式的数据库、受管源文件、备份和日志目录。")]
    public string LocalDataDirectory { get; set; } = NovelLibraryLocalSettings.LocalDataDirectory;

    [Category("诊断")]
    [DisplayName("日志级别")]
    [Description("可选值：error、warn、info、debug。")]
    public string LogLevel { get; set; } = NovelLibraryLocalSettings.LogLevel;

    [Category("本地 Runtime")]
    [DisplayName("保留受管源文件")]
    [Description("导入后保留源文件副本以便重新解析；关闭可节省空间，但原文件移动后将无法重新解析。")]
    public bool RetainManagedSource { get; set; } = NovelLibraryLocalSettings.RetainManagedSource;

    protected override void OnApply(PageApplyEventArgs e)
    {
        var currentDirectory = NovelLibraryLocalSettings.LocalDataDirectory;
        var requestedDirectory = string.IsNullOrWhiteSpace(LocalDataDirectory)
            ? NovelLibraryLocalSettings.DefaultLocalDataDirectory
            : LocalDataDirectory;
        if (!string.Equals(System.IO.Path.GetFullPath(requestedDirectory), System.IO.Path.GetFullPath(currentDirectory), StringComparison.OrdinalIgnoreCase))
        {
            var migrationLock = NovelLibraryLocalSettings.BeginMigration(currentDirectory);
            try
            {
                ThreadHelper.JoinableTaskFactory.Run(async () => await NovelLibraryBridge.ShutdownLocalRuntimeAsync());
                NovelLibraryLocalSettings.SetLocalDataDirectory(requestedDirectory, currentDirectory);
            }
            finally { NovelLibraryLocalSettings.EndMigration(migrationLock); }
        }
        NovelLibraryLocalSettings.SetUseDesktopLibrary(UseDesktopLibrary);
        NovelLibraryLocalSettings.SetLogLevel(LogLevel);
        NovelLibraryLocalSettings.SetRetainManagedSource(RetainManagedSource);
        base.OnApply(e);
    }
}
