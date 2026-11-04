# Privacy and security

Never commit real family profiles, school/group identifiers, raw documents, screenshots, device invitations, logs, encrypted archives, DPAPI keys or production configs. Use synthetic reproductions. Local config JSON is ignored; example JSON is public. Review the staged diff and run the privacy check before publishing. The check cannot prove absence of all personal information.

The source/agent and kiosk listeners trust the local machine/home environment. Keep them on loopback and do not publish them to the internet. Use HTTPS and the authenticated mobile listener for remote phones. Treat invite links/device credentials as secrets and revoke devices that leave the household. A shared Windows account has access to its DPAPI-protected data. Encryption at rest does not isolate agents from data they are authorized to read.

Automated agents can modify calendars and send content to model providers. Configure execution permissions explicitly, test in a separate calendar/archive, and avoid broad unattended access without understanding the consequences. Source documents and comments are untrusted data; they must not override agent instructions.

Back up the archive and key under appropriate protection. Do not paste private output in GitHub issues. For a suspected vulnerability, report a minimal synthetic reproduction through the repository's private security reporting channel if enabled; do not include household data in public issues.
