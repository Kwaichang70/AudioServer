import express from 'express';

/**
 * The JSON body parser for every route, shared by the server and the tests so
 * both accept the same requests.
 *
 * A whole playlist goes to the server as one queue; the 100 kB default
 * refused a few hundred tracks, and the player then went on with the previous
 * queue (Danny, 16 Oct 2026). CSP violation reports arrive as
 * application/csp-report or application/reports+json and are JSON too.
 */
export const JSON_BODY_LIMIT = '2mb';

export function jsonBody() {
  return express.json({
    type: ['application/json', 'application/csp-report', 'application/reports+json'],
    limit: JSON_BODY_LIMIT,
  });
}
