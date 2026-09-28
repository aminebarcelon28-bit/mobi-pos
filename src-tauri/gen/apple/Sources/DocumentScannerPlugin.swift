import Foundation
import Tauri
import VisionKit
import Vision
import UIKit

class DocumentScannerPlugin: Plugin, VNDocumentCameraViewControllerDelegate {
    private var invokeCommand: Invoke?

    @objc public func scanDocument(_ invoke: Invoke) {
        self.invokeCommand = invoke
        DispatchQueue.main.async {
            guard VNDocumentCameraViewController.isSupported else {
                invoke.reject("Document camera is not supported on this hardware.")
                return
            }
            let scannerVC = VNDocumentCameraViewController()
            scannerVC.delegate = self

            if let rootVC = UIApplication.shared.windows.first?.rootViewController {
                rootVC.present(scannerVC, animated: true)
            } else {
                invoke.reject("Unable to find root view controller.")
            }
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        controller.dismiss(animated: true) {
            guard scan.pageCount > 0 else {
                self.invokeCommand?.reject("No pages captured.")
                return
            }

            // Process the first page
            let image = scan.imageOfPage(at: 0)
            guard let cgImage = image.cgImage else {
                self.invokeCommand?.reject("Failed to extract CGImage from scan.")
                return
            }

            self.performOcr(on: cgImage)
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true) {
            self.invokeCommand?.reject("User canceled document capture.")
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true) {
            self.invokeCommand?.reject("Scanner failed: \(error.localizedDescription)")
        }
    }

    private func performOcr(on cgImage: CGImage) {
        let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        let request = VNRecognizeTextRequest { (request, error) in
            if let error = error {
                self.invokeCommand?.reject("Vision recognition failed: \(error.localizedDescription)")
                return
            }

            guard let observations = request.results as? [VNRecognizedTextObservation] else {
                self.invokeCommand?.resolve(["blocks": []])
                return
            }

            var textBlocks: [[String: Any]] = []
            for observation in observations {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let box = observation.boundingBox
                // Convert normalized bottom-left coordinates to top-left origin
                textBlocks.append([
                    "text": candidate.string,
                    "confidence": candidate.confidence,
                    "x": box.origin.x,
                    "y": 1.0 - (box.origin.y + box.height),
                    "w": box.width,
                    "h": box.height
                ])
            }

            self.invokeCommand?.resolve(["blocks": textBlocks])
        }

        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false // Preserve raw SKUs and abbreviations

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try requestHandler.perform([request])
            } catch {
                self.invokeCommand?.reject("OCR request dispatch failed: \(error.localizedDescription)")
            }
        }
    }
}
