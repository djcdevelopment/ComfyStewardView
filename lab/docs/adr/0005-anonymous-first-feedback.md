# ADR 0005: Anonymous-first feedback with optional Discord identity

- Status: Accepted
- Date: 2026-09-03

## Context

Early community use needs a low-friction feedback path. Requiring an account would exclude useful
anonymous reports, while accepting a typed name would imply verification that does not exist. Storing
Discord access tokens or introducing a bot would add unnecessary privilege and operational burden.

## Decision

Allow anonymous feedback by default. Visitors may optionally use Discord OAuth with only the `identify`
scope. The server exchanges the authorization code, reads the identity once, discards the access token,
and stores an opaque in-memory identity session for one hour. OAuth state expires after ten minutes and
is tied to a browser nonce. Cookies are secure on HTTPS and scoped to the public path.

Deliver feedback through a validated HTTPS Discord webhook, explicitly allow only the configured owner
mention, cap user/context fields, include a honeypot, and apply per-client rate limits. Do not include
world data or IP addresses in the submitted message. Identified submission fails closed if the verified
session is missing.

## Consequences

Anonymous participation remains easy while an attached identity has clear provenance. Identity sessions
do not survive a process restart, which is acceptable for an optional one-hour convenience. Operating
the public profile requires webhook and OAuth credentials even though visitors are not required to use
Discord.
