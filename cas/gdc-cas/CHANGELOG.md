# Changelog

All notable changes to `gdc-cas` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-23

### Added

- Initial public open-source release of `gdc-cas` for Google Distributed Cloud Air-gapped (GDCag) Certificate Authority Service (CAS).
- RFC 8693 Security Token Service (STS) authentication (`sts-auth.js`) with automatic token refresh, 1-hour ES256 assertion JWTs, `nbf`, and unique `jti` claims.
- Kubernetes Resource Model (KRM) CRUD operations for `CertificateRequest`, `RevokeCertificateRequest`, and `CertificateAuthority` discovery (`getCertificateAuthority`).
- Support for `certificateTemplate`, `subjectOverride`, and `Date` / RFC3339 `notBefore` & `notAfter` validity windows.
- Direct gRPC dataplane mode (`useGrpc: true`) for high-throughput certificate issuance and revocation with configurable gRFC A6 retry policies and HTTP/2 keepalive.
- Full TypeScript declarations (`cas-client.d.ts`) and package `exports` map.
