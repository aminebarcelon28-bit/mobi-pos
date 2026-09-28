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

@InvokeArg
class PrintLabelArgs {
  lateinit var title: String
  lateinit var imageBase64: String
  var widthMm: Double = 50.0
  var heightMm: Double = 25.0
  var copies: Int = 1
}

@InvokeArg
class WifiPrintArgs {
  lateinit var host: String
  var port: Int = 9100
  lateinit var dataBase64: String
  var timeoutMs: Int = 8000
}

@InvokeArg
class BtPrintArgs {
  lateinit var mac: String
  lateinit var dataBase64: String
  var timeoutMs: Int = 15000
}

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.CALL_PHONE], alias = "call"),
    Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "bt")
  ]
)
class PhonePlugin(private val activity: Activity) : Plugin(activity) {
  private var pendingPhone: String? = null
  private var pendingBtAction: (() -> Unit)? = null

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

  @Command
  fun printLabel(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(PrintLabelArgs::class.java)
      val printManager = activity.getSystemService(Activity.PRINT_SERVICE) as? PrintManager
      if (printManager == null) {
        invoke.reject("Service d'impression Android indisponible")
        return
      }

      val raw = args.imageBase64.substringAfter(",", args.imageBase64)
      val bytes = android.util.Base64.decode(raw, android.util.Base64.DEFAULT)
      val bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      if (bitmap == null) {
        invoke.reject("Image d'étiquette illisible")
        return
      }

      val title = args.title.ifBlank { "MobiPOS - Étiquette" }
      val copies = args.copies.coerceIn(1, 200)
      val widthMm = args.widthMm.coerceIn(10.0, 210.0)
      val heightMm = args.heightMm.coerceIn(10.0, 297.0)
      printManager.print(title, LabelPrintAdapter(activity, title, bitmap, widthMm, heightMm, copies), null)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Impossible d'imprimer l'étiquette")
    }
  }

  // ── Direct network-printer drivers (POS hardware, no print dialog) ──
  // Wi-Fi = raw TCP to the printer (default port 9100). Bluetooth = SPP /
  // RFCOMM to a PAIRED classic printer (pair once in Android settings).
  // Both accept raw ESC/POS, TSPL or ZPL bytes — every thermal/label model.

  @Command
  fun wifiPrint(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(WifiPrintArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Paramètres d'impression Wi-Fi invalides")
      return
    }
    Thread {
      var socket: java.net.Socket? = null
      try {
        val raw = args.dataBase64.substringAfter(",", args.dataBase64)
        val bytes = android.util.Base64.decode(raw, android.util.Base64.DEFAULT)
        val timeout = args.timeoutMs.coerceIn(3000, 20000)
        socket = java.net.Socket()
        socket.soTimeout = timeout
        socket.connect(java.net.InetSocketAddress(args.host, args.port.coerceIn(1, 65535)), timeout)
        socket.getOutputStream().write(bytes)
        socket.getOutputStream().flush()
        try { Thread.sleep(300) } catch (_: InterruptedException) {}
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Imprimante Wi-Fi injoignable (${args.host})")
      } finally {
        try { socket?.close() } catch (_: Exception) {}
      }
    }.start()
  }

  private fun hasBtConnectPermission(): Boolean {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) return true
    return ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) ==
      PackageManager.PERMISSION_GRANTED
  }

  private fun btAdapter(): android.bluetooth.BluetoothAdapter? {
    return (activity.getSystemService(Activity.BLUETOOTH_SERVICE) as? android.bluetooth.BluetoothManager)?.adapter
  }

  @Command
  fun bluetoothPrinters(invoke: Invoke) {
    try {
      if (!hasBtConnectPermission()) {
        pendingBtAction = { listBondedPrinters(invoke) }
        requestPermissionForAlias("bt", invoke, "btPermissionResult")
        return
      }
      listBondedPrinters(invoke)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Lecture Bluetooth impossible")
    }
  }

  private fun listBondedPrinters(invoke: Invoke) {
    try {
      val adapter = btAdapter()
      if (adapter == null) {
        invoke.reject("Bluetooth indisponible sur cet appareil")
        return
      }
      val arr = org.json.JSONArray()
      for (device in adapter.bondedDevices) {
        arr.put(
          org.json.JSONObject()
            .put("name", device.name ?: "Inconnu")
            .put("mac", device.address)
        )
      }
      invoke.resolve(JSObject().put("devices", arr))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Lecture Bluetooth impossible")
    }
  }

  @Command
  fun bluetoothPrint(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(BtPrintArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Paramètres d'impression Bluetooth invalides")
      return
    }
    if (!hasBtConnectPermission()) {
      pendingBtAction = { doBluetoothPrint(invoke, args) }
      try {
        requestPermissionForAlias("bt", invoke, "btPermissionResult")
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Permission Bluetooth requise")
      }
      return
    }
    Thread { doBluetoothPrint(invoke, args) }.start()
  }

  private fun doBluetoothPrint(invoke: Invoke, args: BtPrintArgs) {
    var socket: android.bluetooth.BluetoothSocket? = null
    try {
      val raw = args.dataBase64.substringAfter(",", args.dataBase64)
      val bytes = android.util.Base64.decode(raw, android.util.Base64.DEFAULT)
      val adapter = btAdapter()
      if (adapter == null) {
        invoke.reject("Bluetooth indisponible sur cet appareil")
        return
      }
      if (!adapter.isEnabled) {
        invoke.reject("Bluetooth désactivé — activez-le puis réessayez")
        return
      }
      val device = try {
        adapter.getRemoteDevice(args.mac)
      } catch (error: Exception) {
        invoke.reject("Adresse Bluetooth invalide")
        return
      }
      socket = device.createRfcommSocketToServiceRecord(
        java.util.UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
      )
      adapter.cancelDiscovery()
      socket.connect()
      socket.outputStream.write(bytes)
      socket.outputStream.flush()
      try { Thread.sleep(400) } catch (_: InterruptedException) {}
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Imprimante Bluetooth injoignable — vérifiez l'appairage")
    } finally {
      try { socket?.close() } catch (_: Exception) {}
    }
  }

  @PermissionCallback
  fun btPermissionResult(invoke: Invoke) {
    val action = pendingBtAction
    pendingBtAction = null
    if (!hasBtConnectPermission()) {
      invoke.reject("Permission Bluetooth refusée")
      return
    }
    if (action == null) {
      invoke.reject("Action Bluetooth introuvable — réessayez")
      return
    }
    action()
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

  private class LabelPrintAdapter(
    private val context: Context,
    private val title: String,
    private val bitmap: android.graphics.Bitmap,
    widthMm: Double,
    heightMm: Double,
    copies: Int
  ) : PrintDocumentAdapter() {
    private val pageCount = copies.coerceIn(1, 200)
    private val milsW = (widthMm * 1000.0 / 25.4).toInt().coerceAtLeast(100)
    private val milsH = (heightMm * 1000.0 / 25.4).toInt().coerceAtLeast(100)
    private var attributes: PrintAttributes? = null

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

      // Custom media size matching the physical label roll (e.g. 50x25 mm).
      // Printers without that exact size fall back to fit-to-page scaling.
      val mediaSize = PrintAttributes.MediaSize("MOBI_LABEL", "Étiquette", milsW, milsH)
      attributes = PrintAttributes.Builder()
        .setMediaSize(mediaSize)
        .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
        .setResolution(PrintAttributes.Resolution("r203", "203dpi", 203, 203))
        .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
        .build()
      val info = PrintDocumentInfo.Builder(title)
        .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
        .setPageCount(pageCount)
        .build()
      callback.onLayoutFinished(info, true)
    }

    override fun onWrite(
      pages: Array<out android.print.PageRange>,
      destination: ParcelFileDescriptor,
      cancellationSignal: CancellationSignal?,
      callback: WriteResultCallback
    ) {
      val attrs = attributes
      if (attrs == null || cancellationSignal?.isCanceled == true) {
        callback.onWriteCancelled()
        return
      }

      val pdf = PrintedPdfDocument(context, attrs)
      try {
        val media = attrs.mediaSize
        if (media == null) {
          callback.onWriteFailed("Taille de page inconnue")
          return
        }
        val pageWpt = media.widthMils * 72 / 1000
        val pageHpt = media.heightMils * 72 / 1000
        for (range in pages) {
          for (i in range.start..range.end) {
            if (cancellationSignal?.isCanceled == true) {
              callback.onWriteCancelled()
              return
            }
            val page = pdf.startPage(android.graphics.pdf.PdfDocument.PageInfo.Builder(pageWpt, pageHpt, i).create())
            page.canvas.drawColor(android.graphics.Color.WHITE)
            val scale = minOf(
              page.canvas.width / bitmap.width.toFloat(),
              page.canvas.height / bitmap.height.toFloat()
            )
            val dw = bitmap.width * scale
            val dh = bitmap.height * scale
            val left = (page.canvas.width - dw) / 2f
            val top = (page.canvas.height - dh) / 2f
            page.canvas.drawBitmap(
              bitmap, null,
              android.graphics.RectF(left, top, left + dw, top + dh),
              Paint().apply { isFilterBitmap = true }
            )
            pdf.finishPage(page)
          }
        }
        pdf.writeTo(java.io.FileOutputStream(destination.fileDescriptor))
        callback.onWriteFinished(arrayOf(android.print.PageRange.ALL_PAGES))
      } catch (error: Exception) {
        callback.onWriteFailed(error.message)
      } finally {
        pdf.close()
        destination.close()
      }
    }
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
