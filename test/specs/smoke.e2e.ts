import { expect, browser, $ } from '@wdio/globals';

describe('MobiPOS Desktop Smoke Test', () => {
  it('should launch desktop app, mount webview root, and display header/title', async () => {
    // Wait for the main webview root element to exist
    const rootElement = await $('#root');
    await rootElement.waitForExist({
      timeout: 30000,
      timeoutMsg: 'Expected #root element to exist within 30s',
    });
    await expect(rootElement).toExist();

    // Confirm the initial header is displayed properly
    const header = await $('header');
    await header.waitForDisplayed({
      timeout: 30000,
      timeoutMsg: 'Expected <header> element to be displayed within 30s',
    });
    await expect(header).toBeDisplayed();

    // Confirm the window title matches MobiPOS
    const title = await browser.getTitle();
    expect(title).toMatch(/MobiPOS|MOBI/i);
  });
});

