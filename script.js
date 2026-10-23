const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('request', req => {
        const url = req.url();
        if (url.includes('.m3u8') || url.includes('.ts') || url.includes('api')) {
            console.log("REQ: " + url.substring(0, 150));
        }
    });
    page.on('response', async res => {
        const url = res.url();
        if (url.includes('api') && res.request().resourceType() === 'fetch') {
            try {
                const text = await res.text();
                console.log("RES API (" + url + "): " + text.substring(0, 300));
            } catch(e) {}
        }
    });
    try {
        await page.goto("https://haijiao.com/post/details?pid=2270557", { waitUntil: "networkidle", timeout: 15000 });
    } catch(e) { console.log(e.message); }
    await browser.close();
})();
