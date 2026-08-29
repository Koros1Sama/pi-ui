// src/renderer/src/test-setup.ts
import '@testing-library/jest-dom'

// jsdom doesn't implement scrollTo/scrollIntoView — provide no-ops (only in browser/jsdom environment)
if (typeof Element !== 'undefined') {
  Element.prototype.scrollTo = () => {}
  Element.prototype.scrollIntoView = () => {}
}
