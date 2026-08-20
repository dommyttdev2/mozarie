// This runs while index.html is parsed, so document.write preserves classic
// script ordering without adding a bundler or module runtime.
document.write(window.MOZARIE_SCRIPT_ORDER.map((name) => `<script src="/js/${name}"><\\/script>`).join(""));
