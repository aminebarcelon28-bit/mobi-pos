package com.mobi.pos

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.print.pdf.PrintedPdfDocument
import android.graphics.Paint
import androidx.core.app.ActivityCompat
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class CallArgs {
  lateinit var phone: String
}

@InvokeArg
class WhatsAppArgs {
  lateinit var url: String
}

@InvokeArg
class PrintArgs {
  lateinit var title: String
  lateinit var content: String
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.CALL_PHONE], alias = "call")
  ]
)
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
  private var pendingPhone: String? = null

  @Command
  fun call(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CallArgs::class.java)
      val phone = cleanPhone(args.phone)
      if (phone.isEmpty()) {
        invoke.reject("Numéro de téléphone vide")
        return
      }

      if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
        pendingPhone = phone
        requestPermissionForAlias("call", invoke, "callPermissionResult")
        return
      }

      placeCall(invoke, phone)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Impossible de lancer l'appel")
    }
  }

  @PermissionCallback
  fun callPermissionResult(invoke: Invoke) {
    val phone = pendingPhone
    pendingPhone = null
    if (phone == null) {
      invoke.reject("Numéro de téléphone introuvable")
      return
    }

    if (ActivityCompat.checkSelfPermission(activity, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
      invoke.reject("Permission d'appel refusée")
      return
    }

    placeCall(invoke, phone)
  }

  @Command
  fun whatsapp(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(WhatsAppArgs::class.java)
      val source = Uri.parse(args.url)
      val phone = source.pathSegments.firstOrNull().orEmpty()
      val text = source.getQueryParameter("text").orEmpty()
      if (phone.isEmpty()) {
        invoke.reject("Numéro WhatsApp invalide")
        return
      }

      val target = Uri.Builder()
        .scheme("whatsapp")
        .authority("send")
        .appendQueryParameter("phone", phone)
        .appendQueryParameter("text", text)
        .build()
      val intent = Intent(Intent.ACTION_VIEW, target)
      if (intent.resolveActivity(activity.packageManager) == null) {
        invoke.reject("WhatsApp n'est pas installé")
        return
      }

      activity.startActivity(intent)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Impossible d'ouvrir WhatsApp")
    }
  }

  @Command
  fun print(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PrintArgs::class.java)
      val printManager = activity.getSystemService(Activity.PRINT_SERVICE) as? PrintManager
      if (printManager == null) {
        invoke.reject("Service d'impression Android indisponible")
        return
      }

      val title = args.title.ifBlank { "MobiPOS - Bon fournisseur" }
      val content = args.content
      printManager.print(title, SupplierPrintAdapter(activity, title, content), null)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Impossible d'ouvrir l'impression Android")
    }
  }

  private fun placeCall(invoke: Invoke, phone: String) {
    val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:${Uri.encode(phone)}"))
    if (intent.resolveActivity(activity.packageManager) == null) {
      invoke.reject("Aucune application téléphonique disponible")
      return
    }

    activity.startActivity(intent)
    invoke.resolve()
  }

  private fun cleanPhone(phone: String): String {
    return phone.filter { it.isDigit() || it == '+' }
  }

  private class SupplierPrintAdapter(
    private val context: Context,
    private val title: String,
    private val content: String
  ) : PrintDocumentAdapter() {
    private var document: PrintedPdfDocument? = null

    override fun onLayout(
      oldAttributes: PrintAttributes?,
      newAttributes: PrintAttributes,
      cancellationSignal: CancellationSignal?,
      callback: LayoutResultCallback,
      extras: android.os.Bundle?
    ) {
      if (cancellationSignal?.isCanceled == true) {
        callback.onLayoutCancelled()
        return
      }

      document = PrintedPdfDocument(context, newAttributes)
      val info = PrintDocumentInfo.Builder(title)
        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
        .setPageCount(1)
        .build()
      callback.onLayoutFinished(info, true)
    }

    override fun onWrite(
      pages: Array<out android.print.PageRange>,
      destination: ParcelFileDescriptor,
      cancellationSignal: CancellationSignal?,
      callback: WriteResultCallback
    ) {
      val pdf = document
      if (pdf == null || cancellationSignal?.isCanceled == true) {
        callback.onWriteCancelled()
        return
      }

      try {
        val page = pdf.startPage(android.graphics.pdf.PdfDocument.PageInfo.Builder(595, 842, 1).create())
        val paint = Paint().apply {
          color = android.graphics.Color.BLACK
          textSize = 11f
          isAntiAlias = true
        }
        var y = 36f
        content.lines().take(52).forEach { line ->
          page.canvas.drawText(line.take(92), 28f, y, paint)
          y += 15f
        }
        pdf.finishPage(page)
        pdf.writeTo(java.io.FileOutputStream(destination.fileDescriptor))
        callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES))
      } catch (error: Exception) {
        callback.onWriteFailed(error.message)
      } finally {
        pdf.close()
        document = null
        destination.close()
      }
    }
  }
}
