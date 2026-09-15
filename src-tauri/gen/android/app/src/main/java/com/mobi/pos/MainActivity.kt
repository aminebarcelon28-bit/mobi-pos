package com.mobi.pos

import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var activeWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(wv: WebView) {
    super.onWebViewCreate(wv)
    this.activeWebView = wv
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      activeWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('mobi:back-pressed'));",
        null
      )
      return true
    }
    return super.onKeyDown(keyCode, event)
  }
}
