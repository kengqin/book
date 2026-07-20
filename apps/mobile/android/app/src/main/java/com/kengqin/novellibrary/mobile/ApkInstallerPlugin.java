package com.kengqin.novellibrary.mobile;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void install(PluginCall call) {
        String rawUrl = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        if (rawUrl == null || rawUrl.isBlank()) {
            call.reject("APK 下载地址为空");
            return;
        }
        executor.execute(() -> downloadAndInstall(call, rawUrl, expectedSha256));
    }

    private void downloadAndInstall(PluginCall call, String rawUrl, String expectedSha256) {
        File output = new File(getContext().getCacheDir(), "novel-library-update.apk");
        try {
            URL requested = new URL(rawUrl);
            validateHost(requested);
            HttpURLConnection connection = (HttpURLConnection) requested.openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            connection.connect();
            if (connection.getResponseCode() < 200 || connection.getResponseCode() >= 300) {
                throw new IllegalStateException("APK 下载失败：HTTP " + connection.getResponseCode());
            }
            validateHost(connection.getURL());
            long declaredLength = connection.getContentLength();
            if (declaredLength > MAX_APK_BYTES) throw new IllegalStateException("APK 文件超过 512 MB");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long total = 0;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream input = connection.getInputStream(); FileOutputStream outputStream = new FileOutputStream(output)) {
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_APK_BYTES) throw new IllegalStateException("APK 文件超过 512 MB");
                    digest.update(buffer, 0, read);
                    outputStream.write(buffer, 0, read);
                }
            } finally {
                connection.disconnect();
            }
            if (total == 0) throw new IllegalStateException("APK 文件为空");
            String actualSha256 = hex(digest.digest());
            if (expectedSha256 != null && !expectedSha256.isBlank() && !actualSha256.equalsIgnoreCase(expectedSha256)) {
                throw new IllegalStateException("APK SHA-256 校验失败");
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(settingsIntent);
                throw new IllegalStateException("请允许小说书库安装未知应用后重试");
            }

            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", output);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(uri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(installIntent);
            call.resolve(new JSObject());
        } catch (Exception error) {
            if (output.exists()) output.delete();
            call.reject(error.getMessage() == null ? "APK 安装失败" : error.getMessage());
        }
    }

    private static void validateHost(URL url) {
        if (!"https".equalsIgnoreCase(url.getProtocol())) throw new IllegalArgumentException("APK 地址必须使用 HTTPS");
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!("github.com".equals(host) || "objects.githubusercontent.com".equals(host))) {
            throw new IllegalArgumentException("APK 地址不是官方允许的下载域名");
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) builder.append(String.format(Locale.ROOT, "%02x", value));
        return builder.toString();
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
