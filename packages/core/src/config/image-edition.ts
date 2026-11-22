/**
 * The edition this code was packaged as. Source checkouts and dev images keep
 * "dev"; the Dockerfile rewrites this file to "release" in the same step that
 * writes build-info.json, so a release image whose build-info.json is
 * missing or says "dev" refuses to start (D-089) instead of falling back to
 * the dev edition.
 */
export const IMAGE_EDITION = 'dev' as 'dev' | 'release';
