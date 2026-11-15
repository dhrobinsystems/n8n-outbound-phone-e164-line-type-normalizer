# Disclaimer

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.

## ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`n8n-outbound-phone-e164-line-type-normalizer`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
* **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
* **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled before connecting live HubSpot credentials. Treat every contact property update as a change that sequences, dialers and SMS tools may act on immediately, and confirm the per-lookup cost and daily budget before switching `LOOKUP_PROVIDER` away from `mock`.
* **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, Twilio and any connected services. That includes telemarketing and messaging rules such as the TCPA and the equivalent rules of every country contacted, do-not-call registries and carrier messaging policies. An "SMS eligible" flag describes the line type only. It is not proof of consent, and every outbound call or message still needs a lawful basis and a recorded opt-in where the law requires one.

The full disclaimer is also available in [DISCLAIMER.md](https://github.com/dhrobinsystems/n8n-outbound-phone-e164-line-type-normalizer/blob/main/DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](https://github.com/dhrobinsystems/n8n-outbound-phone-e164-line-type-normalizer/blob/main/LICENSE).

DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
