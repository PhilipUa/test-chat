import { parseJson } from './util.js';

/** HTTP access. One error shape for the whole app, so callers can branch on status and retryAfter. */

export async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    // An error response isn't guaranteed to be JSON — a proxy 502 or 503 won't be.
    const payload = parseJson(await res.text()) ?? {};
    const err = new Error(payload.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('Retry-After')) || payload.details?.retryAfterSeconds;
    throw err;
  }
  return res.json();
}

export const getUsers = () => api('/api/users');

/** The inbox is paged; `cursor` comes from the previous page's `nextCursor`. */
export const getConversations = (userId, { cursor } = {}) => {
  const query = new URLSearchParams({ userId });
  if (cursor) query.set('cursor', cursor);
  return api(`/api/conversations?${query}`);
};

export const getMessages = (conversationId, userId, params = {}) => {
  const query = new URLSearchParams({ conversationId, userId, ...params });
  return api(`/api/messages?${query}`);
};

export const postMessage = (payload) =>
  api('/api/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

export const postRead = (conversationId, userId, messageId) =>
  api(`/api/conversations/${conversationId}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, messageId }),
  });

export const createConversation = (title, participantIds) =>
  api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, participantIds }),
  });

export const search = (q, userId, offset = 0) =>
  api(`/api/search?q=${encodeURIComponent(q)}&userId=${userId}&offset=${offset}`);
