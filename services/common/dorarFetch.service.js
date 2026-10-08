const { decode } = require('html-entities');
const { parseHTML } = require('linkedom');

const fetchWithTimeout = require('../../utils/fetchWithTimeout');
const { current, measure } = require('../../utils/requestTimings');

const loadDocument = async (url) => {
  const response = await fetchWithTimeout(url);
  const html = await response.text();
  return measure('parse', () => parseHTML(decode(html)).document);
};

const documents = new Map();
const fetchDocument = (url) => {
  if (current()?.deduplicate === false) return loadDocument(url);
  if (!documents.has(url)) {
    documents.set(
      url,
      loadDocument(url).finally(() => documents.delete(url)),
    );
  }
  return documents.get(url);
};

const fetchDecodedJsonBody = async (url) => {
  const response = await fetchWithTimeout(url);
  return measure('parse', () => response.json());
};

module.exports = {
  fetchDocument,
  fetchDecodedJsonBody,
};
