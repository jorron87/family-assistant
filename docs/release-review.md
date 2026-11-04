# Initial public release review

This repository starts with fresh Git history. It is an allowlisted source export, not a copy of a household working directory.

Included: application source, browser collector, generic operational scripts, UI, synthetic tests, configuration templates and new setup documentation. Excluded: household profiles/configs, raw school documents, photos/screenshots, archives/keys, local incident history, one-off data corrections, camera identities, browser profiles and credentials.

Verification on Windows/Node24: 292 tests passed; fresh installation served dashboard/mobile successfully with a custom two-member profile and collection disabled; dependency audit reported zero findings. Member-count/homework and external configuration regression tests cover a different household. The later small homework eligibility correction was verified with the affected tests. Git ignore rules and an automated privacy guard supplement manual release review; no automated scanner can prove complete anonymity.

Known scope: Windows DPAPI host, Norwegian-first UI and timezone handling, unofficial source APIs, optional site-specific activity adapters, and separately configured external model/OAuth/HTTPS/camera access. No production configuration, service account or working login is included. Test against your own separate calendar before unattended use.
