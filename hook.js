
// ==UserScript==
// @name         Haijiao Video Downloader
// @match        *://*.haijiao.com/*
// @grant        none
// ==/UserScript==

(function() {
    let buffers = [];
    const origAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function(data) {
        buffers.push(new Uint8Array(data));
        origAppend.call(this, data);
    };
    window.addEventListener("load", () => {
        const btn = document.createElement("button");
        btn.innerText = "Download Video";
        btn.style.cssText = "position:fixed;top:10px;right:10px;z-index:9999;padding:10px;background:red;color:white;";
        btn.onclick = () => {
            const blob = new Blob(buffers, { type: "video/mp4" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = "video.mp4"; a.click();
        };
        document.body.appendChild(btn);
    });
})();
