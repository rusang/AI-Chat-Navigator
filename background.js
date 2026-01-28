// MV3 service worker for keyboard shortcuts (chrome.commands)
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-gnp-sidebar') return;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) return;

    // Ask the content script to toggle the sidebar
    chrome.tabs.sendMessage(tab.id, { type: 'GNP_TOGGLE_SIDEBAR', command });
  } catch (e) {
    // Ignore errors (e.g., no active tab, content script not injected on this page)
  }
});
