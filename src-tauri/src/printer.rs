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

        fn GetDefaultPrinterW(
            p_printer_name: *mut u16,
            pcch_buffer: *mut u32,
        ) -> i32;
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
            let mut open_ok = false;

            if !printer_name.is_empty()
                && OpenPrinterW(printer_name_wide.as_ptr(), &mut h_printer, null_mut()) != 0
            {
                open_ok = true;
            }

            if !open_ok {
                // Fallback to default Windows printer
                let mut buf_size: u32 = 512;
                let mut def_buf: Vec<u16> = vec![0u16; 512];
                if GetDefaultPrinterW(def_buf.as_mut_ptr(), &mut buf_size) != 0
                    && OpenPrinterW(def_buf.as_ptr(), &mut h_printer, null_mut()) != 0
                {
                    open_ok = true;
                }
            }

            if !open_ok {
                eprintln!("[printer] Windows printer '{}' not found and no default printer available", printer_name);
                return Ok(());
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

        if data.len() > 2 * 1024 * 1024 {
            return Err("Le tampon d'impression dépasse la taille maximale sécurisée de 2 Mo".into());
        }
        let data_len: u32 = u32::try_from(data.len())
            .map_err(|_| "Taille des données d'impression invalide".to_string())?;

        let mut written: u32 = 0;
        let write_res = WritePrinter(
            h_printer,
            data.as_ptr(),
            data_len,
            &mut written,
        );

        EndPagePrinter(h_printer);
        EndDocPrinter(h_printer);
        ClosePrinter(h_printer);

        if write_res == 0 || written != data_len {
            return Err("Erreur lors de l'écriture des données brutes vers l'imprimante".into());
        }

        Ok(())
    }
    }
}

#[cfg(mobile)]
mod win {
    pub fn print_raw(_printer_name: &str, _data: &[u8]) -> Result<(), String> {
        Err("Impression mobile non configurée (prévoir plugin Bluetooth/BLE).".into())
    }
}

#[cfg(all(not(target_os = "windows"), not(mobile)))]
mod win {
    pub fn print_raw(_printer_name: &str, _data: &[u8]) -> Result<(), String> {
        Ok(())
    }
}

pub const ESC_INIT: [u8; 2] = [0x1B, 0x40];
pub const DRAWER_KICK: [u8; 5] = [0x1B, 0x70, 0x00, 0x19, 0xFA];
pub const PAPER_FULL_CUT: [u8; 4] = [0x1D, 0x56, 0x41, 0x00];
pub const PAPER_PARTIAL_CUT: [u8; 4] = [0x1D, 0x56, 0x42, 0x00];
pub const ALIGN_LEFT: [u8; 3] = [0x1B, 0x61, 0x00];
pub const ALIGN_CENTER: [u8; 3] = [0x1B, 0x61, 0x01];
pub const ALIGN_RIGHT: [u8; 3] = [0x1B, 0x61, 0x02];
pub const BOLD_ON: [u8; 3] = [0x1B, 0x45, 0x01];
pub const BOLD_OFF: [u8; 3] = [0x1B, 0x45, 0x00];

pub fn print_raw_bytes(printer_name: &str, data: &[u8]) -> Result<(), String> {
    if data.len() > 2 * 1024 * 1024 {
        return Err("Le tampon d'impression dépasse la taille maximale sécurisée de 2 Mo".into());
    }
    win::print_raw(printer_name, data)
}
