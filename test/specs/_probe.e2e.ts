describe('probe', () => {
  it('waits so backend emits logs', async () => {
    await browser.pause(6000);
    const html = await browser.$('#root');
    console.log('[PROBE] root exists =', await html.isExisting());
  });
});
