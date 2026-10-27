/**
 * Raw CDP Client for Tauri WebView2
 *
 * Connects directly to the WebView2's page-level CDP WebSocket endpoint.
 * Provides:
 *   - send(method, params): Send a CDP command and wait for response
 *   - evaluate(expression): Execute JavaScript in the page context
 *   - click(selector): Click an element matching a CSS selector
 *   - fill(selector, text): Fill an input field
 *   - textContent(selector): Get text content of an element
 *   - waitFor(selector, timeout): Wait for an element to appear
 *
 * This is used instead of Playwright's connectOverCDP because WebView2
 * only exposes page-level CDP endpoints, not browser-level ones.
 */

const CDP_PORT = 9222;

export class CdpClient {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.events = [];
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.webSocketUrl);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
          this.connected = true;
          resolve();
        };
        this.ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e}`));
        this.ws.onmessage = (e) => this._handleMessage(e.data);
        this.ws.onclose = () => {
          this.connected = false;
          // Reject pending commands
          for (const [id, { reject }] of this.pending) {
            reject(new Error('CDP connection closed'));
          }
          this.pending.clear();
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  _handleMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      // Event
      this.events.push(msg);
    }
  }

  async send(method, params = {}) {
    if (!this.connected || !this.ws) {
      throw new Error('CDP client not connected');
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, 10000);
    });
  }

  async enableDomains() {
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    await this.send('Network.enable');
  }

  /**
   * Evaluate JavaScript in the page context and return the result.
   */
  async evaluate(expression, returnByValue = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.result && result.result.type === 'error') {
      throw new Error(`JS evaluation error: ${result.result.description}`);
    }
    return result.result && result.result.value;
  }

  /**
   * Evaluate JavaScript that returns an object handle (for further interaction).
   */
  async evaluateHandle(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: false,
      awaitPromise: true,
      userGesture: true,
    });
    return result.result && result.result.objectId;
  }

  /**
   * Call a function on an object handle.
   */
  async callObject(objectId, functionDeclaration, ...args) {
    const result = await this.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: args.map((a) => ({ value: a })),
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result && result.result.value;
  }

  /**
   * Release an object handle.
   */
  async releaseObject(objectId) {
    await this.send('Runtime.releaseObject', { objectId });
  }

  /**
   * Query a DOM element by CSS selector, returning the object handle.
   */
  async querySelector(selector) {
    const doc = await this.send('DOM.getDocument', { depth: -1 });
    const rootId = doc.root.nodeId;
    const result = await this.send('DOM.querySelector', {
      nodeId: rootId,
      selector,
    });
    return result.nodeId;
  }

  /**
   * Query all DOM elements matching a CSS selector.
   */
  async querySelectorAll(selector) {
    const doc = await this.send('DOM.getDocument', { depth: -1 });
    const rootId = doc.root.nodeId;
    const result = await this.send('DOM.querySelectorAll', {
      nodeId: rootId,
      selector,
    });
    return result.nodeIds || [];
  }

  /**
   * Find an element by text content (exact match on trimmed text).
   * Returns the DOM nodeId or null.
   */
  async findByText(tag, text, exact = false) {
    const js = exact
      ? `(tag) => Array.from(document.querySelectorAll(tag)).find(e => e.textContent.trim() === text)`
      : `(tag) => Array.from(document.querySelectorAll(tag)).find(e => e.textContent.includes(text))`;
    const handle = await this.evaluateHandle(js);
    // We need the nodeId, not the JS handle. Use DOM.resolveNode via the object's backend node ID.
    // Simpler: evaluate and return the node's backend node ID
    const result = await this.evaluate(`
      (() => {
        const els = Array.from(document.querySelectorAll(${JSON.stringify(tag)}));
        const el = els.find(e => ${exact ? `e.textContent.trim() === ${JSON.stringify(text)}` : `e.textContent.includes(${JSON.stringify(text)})`});
        return el ? el['__pos_node_id'] ?? null : null;
      })()
    `);
    // This won't work directly. Instead, use XPath:
    const xpathResult = await this.send('DOM.evaluateXPath', {
      expression: exact
        ? `//${tag}[normalize-space(text()) = ${JSON.stringify(text)}]`
        : `//${tag}[contains(normalize-space(string()), ${JSON.stringify(text)})]`,
      useShadowTree: true,
    });
    return xpathResult?.nodeIds?.[0] ?? null;
  }

  /**
   * Find all elements matching a predicate via XPath.
   */
  async findAllByText(tag, text) {
    const result = await this.send('DOM.evaluateXPath', {
      expression: `//${tag}[contains(normalize-space(string()), ${JSON.stringify(text)})]`,
      useShadowTree: true,
    });
    return result.nodeIds || [];
  }

  /**
   * Fill an input field matching a CSS selector.
   * Sets the value and dispolves input/change events.
   */
  async fill(selector, text) {
    const js = `(selector, text) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`;
    const result = await this.evaluate(`(${js})(${JSON.stringify(selector)}, ${JSON.stringify(text)})`);
    if (!result) throw new Error(`Element not found: ${selector}`);
  }

  /**
   * Click an element found by CSS selector or text content.
   * If selector starts with "text:", find by text content.
   */
  async click(selectorOrText) {
    let result;
    if (selectorOrText.startsWith('text:')) {
      const text = selectorOrText.slice(5);
      result = await this.clickByText('button', text, false);
    } else {
      const js = `(selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
      }`;
      result = await this.evaluate(`(${js})(${JSON.stringify(selectorOrText)})`);
    }
    if (!result) throw new Error(`Element not found: ${selectorOrText}`);
  }

  /**
   * Click an element found by data-testid attribute using dispatchEvent.
   */
  async clickTestId(testid) {
    const result = await this.evaluate(`(testid) => {
      const el = document.querySelector('[data-testid="' + testid + '"]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }`, testid);
    if (!result) throw new Error(`Element not found: [data-testid="${testid}"]`);
  }

  /**
   * Fill an input field matching a CSS selector.
   */
  async fill(selector, text) {
    const nodeId = await this.querySelector(selector);
    if (!nodeId) throw new Error(`Element not found: ${selector}`);
    // Focus the element
    await this.send('DOM.focus', { nodeId });
    // Select all and type
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: 65, // 'A'
      modifiers: 8, // Ctrl
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 65,
      modifiers: 8,
    });
    // Type the text
    for (const char of text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        text: char,
        unmodifiedText: char,
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: char.charCodeAt(0),
      });
      await this.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: char.charCodeAt(0),
      });
    }
  }

  /**
   * Press a key.
   */
  async pressKey(key) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      windowsVirtualKeyCode: this._keyCode(key),
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: this._keyCode(key),
    });
  }

  _keyCode(key) {
    const map = {
      'Enter': 13,
      'Escape': 27,
      'F11': 122,
      'Tab': 9,
      'Backspace': 8,
    };
    return map[key] || key.charCodeAt(0);
  }

  /**
   * Get text content of an element matching a CSS selector.
   */
  async textContent(selector) {
    const nodeId = await this.querySelector(selector);
    if (!nodeId) return null;
    const result = await this.send('DOM.getOuterHTML', { nodeId });
    return result.outerHTML;
  }

  /**
   * Wait for an element matching a CSS selector to appear.
   */
  async waitFor(selector, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const nodeId = await this.querySelector(selector);
        if (nodeId) return nodeId;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Element not found within ${timeoutMs}ms: ${selector}`);
  }

  /**
   * Wait for a condition (JS expression) to be true.
   */
  async waitForFunction(expression, timeoutMs = 10000, pollingInterval = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const result = await this.evaluate(expression);
        if (result) return result;
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, pollingInterval));
    }
    throw new Error(`Condition not met within ${timeoutMs}ms: ${expression}`);
  }

  /**
   * Get all console messages collected so far.
   */
  getConsoleEvents() {
    return this.events.filter((e) => e.method === 'Log.entryAdded');
  }

  async close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

/**
 * Discover the CDP WebSocket URL for the Tauri WebView2 app.
 */
export async function discoverCdpUrl(port = CDP_PORT) {
  const res = await fetch(`http://localhost:${port}/json`);
  const pages = await res.json();
  if (!pages || pages.length === 0) {
    throw new Error(`No CDP targets found on port ${port}. Is the app running with remote debugging enabled?`);
  }
  const appPage = pages.find((p) => p.url && p.url.includes('tauri.localhost')) || pages[0];
  return {
    pageId: appPage.id,
    url: appPage.url,
    title: appPage.title,
    webSocketDebuggerUrl: appPage.webSocketDebuggerUrl,
    port,
  };
}