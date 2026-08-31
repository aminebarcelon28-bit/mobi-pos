#[cfg(target_os = "windows")]
mod win {
    use std::ptr::null_mut;

    #[repr(C)]
    struct DOC_INFO_1W {
        p_doc_name: *const u16,
        p_output_file: *const u16,
        p_datatype: *const u16,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn OpenPrinterW(
            p_printer_name: *const u16,
            ph_printer: *mut *mut std::ffi::c_void,
            p_default: *const std::ffi::c_void,
        ) -> i32;

        fn StartDocPrinterW(
            h_printer: *mut std::ffi::c_void,
            level: u32,
            p_doc_info: *const DOC_INFO_1W,
        ) -> u32;

        fn StartPagePrinter(h_printer: *mut std::ffi::c_void) -> i32;

        fn WritePrinter(
            h_printer: *mut std::ffi::c_void,
            p_buf: *const u8,
            cb_buf: u32,
            pc_written: *mut u32,
        ) -> i32;

        fn EndPagePrinter(h_printer: *mut std::ffi::c_void) -> i32;

        fn EndDocPrinter(h_printer: *mut std::ffi::c_void) -> i32;

        fn ClosePrinter(h_printer: *mut std::ffi::c_void) -> i32;
    }

    pub fn print_raw(printer_name: &str, data: &[u8]) -> Result<(), String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        let printer_name_wide: Vec<u16> = OsStr::new(printer_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let doc_name_wide: Vec<u16> = OsStr::new("MobiPOS Thermal Receipt")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let raw_type_wide: Vec<u16> = OsStr::new("RAW")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let mut h_printer: *mut std::ffi::c_void = null_mut();
            if OpenPrinterW(printer_name_wide.as_ptr(), &mut h_printer, null_mut()) == 0 {
                return Err(format!("Impossible d'ouvrir l'imprimante Windows '{}'", printer_name));
            }

            let doc_info = DOC_INFO_1W {
                p_doc_name: doc_name_wide.as_ptr(),
                p_output_file: null_mut(),
                p_datatype: raw_type_wide.as_ptr(),
            };

            let doc_id = StartDocPrinterW(h_printer, 1, &doc_info);
            if doc_id == 0 {
                ClosePrinter(h_printer);
                return Err("Échec d'initialisation du travail d'impression (StartDocPrinter)".into());
            }

            StartPagePrinter(h_printer);

            let mut written: u32 = 0;
            let write_res = WritePrinter(
                h_printer,
                data.as_ptr(),
                data.len() as u32,
                &mut written,
            );

            EndPagePrinter(h_printer);
            EndDocPrinter(h_printer);
            ClosePrinter(h_printer);

            if write_res == 0 || written != data.len() as u32 {
                return Err("Erreur lors de l'écriture des données brutes vers l'imprimante".into());
            }

            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    pub fn print_raw(_printer_name: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }
}

pub fn print_raw_bytes(printer_name: &str, data: &[u8]) -> Result<(), String> {
    win::print_raw(printer_name, data)
}
