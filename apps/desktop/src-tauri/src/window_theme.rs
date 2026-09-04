use tauri::WebviewWindow;

#[cfg(target_os = "windows")]
const DWMWA_BORDER_COLOR: u32 = 34;
#[cfg(target_os = "windows")]
const DWMWA_CAPTION_COLOR: u32 = 35;
#[cfg(target_os = "windows")]
const DWMWA_TEXT_COLOR: u32 = 36;
#[cfg(target_os = "windows")]
const DWMWA_COLOR_DEFAULT: u32 = 0xffff_ffff;

#[cfg(target_os = "windows")]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut std::ffi::c_void,
        attribute: u32,
        value: *const std::ffi::c_void,
        value_size: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
const fn colorref(red: u32, green: u32, blue: u32) -> u32 {
    red | (green << 8) | (blue << 16)
}

#[cfg(target_os = "windows")]
unsafe fn set_color_attribute(hwnd: *mut std::ffi::c_void, attribute: u32, color: u32) {
    // Older Windows builds may not support the color attributes. Ignoring the
    // HRESULT keeps Tauri's light/dark title-bar theme as a graceful fallback.
    let _ = DwmSetWindowAttribute(
        hwnd,
        attribute,
        (&color as *const u32).cast(),
        std::mem::size_of::<u32>() as u32,
    );
}

pub fn set_window_palette(window: &WebviewWindow, palette: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let colors = match palette {
            Some("startup") => (
                colorref(14, 23, 21),
                colorref(242, 240, 231),
                colorref(14, 23, 21),
            ),
            Some("app-light") => (
                colorref(245, 245, 244),
                colorref(28, 28, 27),
                colorref(221, 220, 216),
            ),
            Some("app-dark") => (
                colorref(21, 21, 21),
                colorref(244, 244, 242),
                colorref(52, 52, 50),
            ),
            Some("light") => (
                colorref(255, 255, 255),
                colorref(41, 48, 44),
                colorref(219, 224, 220),
            ),
            Some("paper") => (
                colorref(238, 233, 220),
                colorref(45, 48, 44),
                colorref(198, 192, 179),
            ),
            Some("night") => (
                colorref(23, 28, 27),
                colorref(224, 228, 224),
                colorref(53, 65, 62),
            ),
            Some(_) => return Err("unsupported window palette".to_string()),
            None => (
                DWMWA_COLOR_DEFAULT,
                DWMWA_COLOR_DEFAULT,
                DWMWA_COLOR_DEFAULT,
            ),
        };

        unsafe {
            set_color_attribute(hwnd.0, DWMWA_CAPTION_COLOR, colors.0);
            set_color_attribute(hwnd.0, DWMWA_TEXT_COLOR, colors.1);
            set_color_attribute(hwnd.0, DWMWA_BORDER_COLOR, colors.2);
        }
    }

    #[cfg(not(target_os = "windows"))]
    let _ = (window, palette);

    Ok(())
}
