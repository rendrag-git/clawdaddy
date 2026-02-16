# Data Processing Agreement

**ClawDaddy LLC**
**DRAFT — Not yet reviewed by legal counsel**
**Last Updated: February 16, 2026**

---

This Data Processing Agreement ("DPA") forms part of the service agreement ("Agreement") between the customer identified in the Agreement ("Controller" or "Customer") and ClawDaddy LLC, EIN 41-4268878 ("Processor" or "ClawDaddy"), and governs the processing of personal data by ClawDaddy on behalf of the Customer.

---

## 1. Definitions

For the purposes of this DPA:

- **"Controller"** means the Customer, who determines the purposes and means of processing personal data.
- **"Processor"** means ClawDaddy, who processes personal data on behalf of the Controller.
- **"Personal Data"** means any information relating to an identified or identifiable natural person ("Data Subject").
- **"Processing"** means any operation performed on personal data, including collection, storage, use, disclosure, modification, or deletion.
- **"Sub-processor"** means a third party engaged by the Processor to process personal data on behalf of the Controller.
- **"Data Subject"** means an identified or identifiable natural person whose personal data is processed.
- **"Supervisory Authority"** means an independent public authority responsible for monitoring the application of data protection law (e.g., a GDPR supervisory authority).
- **"Data Protection Laws"** means all applicable laws relating to data protection and privacy, including the GDPR (Regulation (EU) 2016/679), the UK GDPR, and other applicable legislation.
- **"GDPR"** means the General Data Protection Regulation (EU) 2016/679.
- **"SCCs"** means the Standard Contractual Clauses approved by the European Commission for international data transfers.

---

## 2. Scope and Purpose of Processing

### 2.1 Scope
This DPA applies to all personal data processed by ClawDaddy on behalf of the Customer in connection with the Service.

### 2.2 Purpose
ClawDaddy processes personal data solely to provide the Service: hosting and operating OpenClaw AI assistants on behalf of the Customer. This includes:
- Hosting and storing Customer's Service Data (conversations, messages, files, configurations)
- Routing AI requests to Anthropic via the Customer's own API key (BYOK model)
- Managing account and billing information
- Providing customer support and maintaining service availability

### 2.3 Categories of Data Subjects
- Customer's end users and contacts who interact with the AI assistant
- Customer's employees or representatives who manage the Service

### 2.4 Types of Personal Data
- Names, email addresses, and contact information
- Conversation content and messages exchanged with AI assistants
- Configuration data and uploaded files
- Usage and technical data (IP addresses, access logs)
- Billing and payment information

### 2.5 Duration
Processing continues for the duration of the Agreement, plus the data deletion period described in Section 10.

---

## 3. Processor Obligations

ClawDaddy shall:

### 3.1 Documented Instructions
Process personal data only on documented instructions from the Controller, including with regard to transfers of personal data outside the EEA/UK, unless required by applicable law. If ClawDaddy is required by law to process personal data outside the Controller's instructions, it will inform the Controller before such processing (unless prohibited by law).

### 3.2 Confidentiality
Ensure that all personnel authorized to process personal data are bound by confidentiality obligations (contractual or statutory).

### 3.3 Security Measures
Implement and maintain appropriate technical and organizational measures to protect personal data, as described in Section 7.

### 3.4 Sub-processors
Comply with the sub-processor requirements in Section 5.

### 3.5 Data Subject Requests
Assist the Controller, by appropriate technical and organizational measures, in responding to requests from Data Subjects exercising their rights under Data Protection Laws (access, rectification, erasure, portability, restriction, objection). ClawDaddy will promptly notify the Controller if it receives a request directly from a Data Subject, and will not respond to such requests without the Controller's authorization unless required by law.

### 3.6 Assistance with Compliance
Assist the Controller in ensuring compliance with obligations related to:
- Security of processing (GDPR Art. 32)
- Breach notification (GDPR Arts. 33–34)
- Data protection impact assessments (GDPR Art. 35)
- Prior consultation with supervisory authorities (GDPR Art. 36)

### 3.7 Breach Notification
Notify the Controller without undue delay, and in any event within **72 hours** of becoming aware of a personal data breach. The notification shall include:
- The nature of the breach, including (where possible) the categories and approximate number of Data Subjects and personal data records affected
- The name and contact details of ClawDaddy's contact point for further information
- The likely consequences of the breach
- The measures taken or proposed to address the breach, including measures to mitigate its possible adverse effects

### 3.8 Deletion and Return
Upon termination of the Agreement, at the Controller's choice, delete or return all personal data to the Controller within **30 days**, and delete existing copies unless applicable law requires retention. ClawDaddy will provide a written confirmation of deletion upon request.

### 3.9 Audit Rights
Make available to the Controller all information necessary to demonstrate compliance with this DPA and GDPR Article 28. ClawDaddy shall allow for and contribute to audits, including inspections, conducted by the Controller or an auditor mandated by the Controller, subject to:
- Reasonable advance notice (at least 30 days, unless a breach necessitates shorter notice)
- Audits conducted during normal business hours
- The Controller bearing the cost of the audit
- Confidentiality obligations regarding ClawDaddy's systems and other customers' data

ClawDaddy may satisfy audit requests by providing relevant certifications, audit reports, or summaries of third-party security assessments, where available.

---

## 4. Controller Obligations

The Controller shall:

- Ensure it has a lawful basis for processing personal data and for instructing ClawDaddy to process personal data on its behalf.
- Provide all necessary notices to, and obtain all necessary consents or authorizations from, Data Subjects as required by Data Protection Laws.
- Ensure that its instructions to ClawDaddy comply with applicable Data Protection Laws.
- Be responsible for the content transmitted through the Service, including any personal data contained in AI assistant conversations.
- Manage its own Anthropic API key and relationship with Anthropic, including compliance with Anthropic's terms and privacy practices (see Section 5.2).

---

## 5. Sub-processors

### 5.1 Authorized Sub-processors
The Controller grants general authorization for ClawDaddy to engage sub-processors. As of the date of this DPA, ClawDaddy uses the following sub-processors:

| Sub-processor | Purpose | Location | Data Processed |
|---|---|---|---|
| **Amazon Web Services (AWS)** | Cloud hosting and infrastructure | US or EU (per Customer's selected region) | All Service Data |
| **Stripe** | Payment processing | US | Billing and payment data |
| **Anthropic** | AI model provider | US | Conversation data (see Section 5.2) |

### 5.2 Anthropic — BYOK Model
ClawDaddy operates a **Bring Your Own Key (BYOK)** model for Anthropic. The Customer provides their own Anthropic API key, and AI requests are routed through the Customer's own Anthropic account. This means:
- The Customer has a **direct contractual relationship** with Anthropic regarding the processing of conversation data.
- ClawDaddy acts as a technical intermediary, routing requests to Anthropic on the Customer's behalf using the Customer's credentials.
- Anthropic's data processing practices are governed by the Customer's agreement with Anthropic, not this DPA.
- The Customer is responsible for ensuring their use of Anthropic's services complies with applicable Data Protection Laws.

### 5.3 Changes to Sub-processors
ClawDaddy will notify the Controller at least **30 days** before engaging a new sub-processor or replacing an existing one. The Controller may object to the new sub-processor within 30 days of notification. If the Controller objects on reasonable data protection grounds and ClawDaddy cannot address the objection, the Controller may terminate the affected portion of the Agreement.

### 5.4 Sub-processor Obligations
ClawDaddy will impose data protection obligations on each sub-processor that are no less protective than those in this DPA. ClawDaddy remains liable for the acts and omissions of its sub-processors.

---

## 6. International Data Transfers

### 6.1 EU Region Hosting
Customers who select the **EU region** have their Service Data stored and processed exclusively within the European Economic Area using AWS EU data centers. Service Data does not leave the EEA for hosting purposes.

### 6.2 US Region Hosting
Customers who select the **US region** have their Service Data stored and processed in the United States.

### 6.3 Transfer Mechanisms
Where personal data is transferred outside the EEA or UK, ClawDaddy relies on:
- **Standard Contractual Clauses (SCCs)** as approved by the European Commission (Commission Implementing Decision (EU) 2021/914), which are hereby incorporated by reference.
- **Adequacy decisions** issued by the European Commission, where applicable.

### 6.4 Additional Safeguards
ClawDaddy will implement supplementary measures where necessary to ensure an adequate level of protection for transferred personal data, considering the circumstances of the transfer in accordance with the *Schrems II* decision (Case C-311/18).

---

## 7. Security Measures

ClawDaddy implements and maintains the following technical and organizational measures:

### 7.1 Encryption
- Data encrypted in transit using TLS 1.2 or higher
- Data encrypted at rest using AES-256 or equivalent

### 7.2 Access Controls
- Role-based access controls for all systems
- Multi-factor authentication for administrative access
- Principle of least privilege enforced

### 7.3 Infrastructure Security
- Region-isolated infrastructure (EU data stays in EU, US data stays in US)
- Network segmentation and firewalls
- Regular security patching and updates

### 7.4 Monitoring and Testing
- Security monitoring and logging
- Regular vulnerability assessments
- Incident response procedures

### 7.5 Personnel
- Confidentiality obligations for all staff with access to personal data
- Security awareness training

---

## 8. Breach Notification

### 8.1 Notification Timeline
ClawDaddy will notify the Controller of any personal data breach without undue delay and no later than **72 hours** after becoming aware of the breach.

### 8.2 Notification Content
The breach notification will include, to the extent available:
1. The nature of the personal data breach
2. The categories and approximate number of Data Subjects concerned
3. The categories and approximate number of personal data records concerned
4. The likely consequences of the breach
5. The measures taken or proposed to address the breach and mitigate its effects
6. The name and contact details of ClawDaddy's point of contact

### 8.3 Cooperation
ClawDaddy will cooperate with the Controller and take reasonable steps to assist in the investigation, mitigation, and remediation of the breach.

---

## 9. Liability

Liability under this DPA is subject to the limitations and exclusions set forth in the Agreement. This DPA does not create liability beyond what is provided in the Agreement, except as required by applicable Data Protection Laws.

---

## 10. Term and Termination

### 10.1 Term
This DPA takes effect on the date the Agreement becomes effective and remains in force for as long as ClawDaddy processes personal data on behalf of the Controller.

### 10.2 Data Deletion
Upon termination of the Agreement, ClawDaddy will delete all personal data within **30 days**, unless:
- The Controller requests return of the data (in a structured, commonly used format)
- Applicable law requires retention

### 10.3 Survival
Sections relating to confidentiality, liability, and any obligations that by their nature should survive termination will survive the termination of this DPA.

---

## 11. General

### 11.1 Governing Law
This DPA is governed by the same law that governs the Agreement, except that GDPR-related provisions are governed by the laws of the applicable EU/EEA member state or the UK, as relevant.

### 11.2 Conflict
In the event of a conflict between this DPA and the Agreement, this DPA prevails with respect to data protection matters.

### 11.3 Amendments
This DPA may be amended by ClawDaddy to reflect changes in Data Protection Laws, with reasonable notice to the Controller.

---

## 12. Contact

For questions about this DPA or data protection matters:

**Email:** pearson@clawdaddy.sh

---

**REMINDER:** This is a draft document and has not been reviewed by legal counsel. It should be reviewed by a qualified attorney familiar with GDPR and data protection law before use.
