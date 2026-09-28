package com.tauri.plugins.scanner

import android.app.Activity
import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

/**
 * PO invoice document capture: GMS scanner UI (camera, crop, enhance) +
 * on-device ML Kit text recognition. Emits normalized OCR word boxes
 * ([x, y, w, h] in 0..1 top-left origin + text + confidence) matching the
 * `OcrBoundingBox` contract consumed by `geometry.rs` via
 * `po_process_raw_scan`.
 *
 * Results return through the Tauri [ActivityCallback] mechanism
 * ([Plugin.startIntentSenderForResult]), never through a manual
 * `startIntentSenderForResult` + request-code switch.
 */
@TauriPlugin
class DocumentScannerPlugin(private val activity: Activity) : Plugin(activity) {
  private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
  private val scanner: GmsDocumentScanner

  init {
    val options = GmsDocumentScannerOptions.Builder()
      .setGalleryImportAllowed(false)
      .setPageLimit(1)
      .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
      .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
      .build()
    scanner = GmsDocumentScanning.getClient(options)
  }

  @Command
  fun scanDocument(invoke: Invoke) {
    scanner.getStartScanIntent(activity)
      .addOnSuccessListener { intentSender ->
        startIntentSenderForResult(
          invoke,
          IntentSenderRequest.Builder(intentSender).build(),
          "onScanResult"
        )
      }
      .addOnFailureListener { e ->
        invoke.reject("Failed to initialize ML Kit scanner: ${e.localizedMessage}")
      }
  }

  @ActivityCallback
  fun onScanResult(invoke: Invoke, result: ActivityResult) {
    val data: Intent? = result.data
    if (result.resultCode != Activity.RESULT_OK || data == null) {
      invoke.reject("User cancelled scanning operation.")
      return
    }

    val scanResult = GmsDocumentScanningResult.fromActivityResultIntent(data)
    val pages = scanResult?.pages
    if (pages.isNullOrEmpty()) {
      invoke.reject("Document scan returned no pages.")
      return
    }

    val image: InputImage
    try {
      image = InputImage.fromFilePath(activity, pages[0].imageUri)
    } catch (e: Exception) {
      invoke.reject("Failed to read scanned page: ${e.localizedMessage}")
      return
    }

    recognizer.process(image)
      .addOnSuccessListener { visionText ->
        try {
          val imgWidth = image.width.toFloat()
          val imgHeight = image.height.toFloat()
          val blocksArray = JSArray()
          for (block in visionText.textBlocks) {
            for (line in block.lines) {
              val box = line.boundingBox ?: continue
              val item = JSObject()
              item.put("text", line.text)
              item.put("confidence", 1.0)
              item.put("x", box.left.toFloat() / imgWidth)
              item.put("y", box.top.toFloat() / imgHeight)
              item.put("w", box.width().toFloat() / imgWidth)
              item.put("h", box.height().toFloat() / imgHeight)
              blocksArray.put(item)
            }
          }
          invoke.resolve(JSObject().put("blocks", blocksArray))
        } catch (e: Exception) {
          invoke.reject("Failed to normalize OCR boxes: ${e.localizedMessage}")
        }
      }
      .addOnFailureListener { e ->
        invoke.reject("ML Kit Text Recognition failed: ${e.localizedMessage}")
      }
  }
}
