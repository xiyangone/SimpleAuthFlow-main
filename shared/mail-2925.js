(function attach2925MailHelpers(globalScope) {
  function normalizeWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeText(value) {
    return normalizeWhitespace(value).toLowerCase();
  }

  function combineDistinctTextParts(parts = []) {
    const seen = new Set();
    const normalizedParts = [];

    for (const part of parts) {
      const value = normalizeWhitespace(part);
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      normalizedParts.push(value);
    }

    return normalizedParts.join(' ');
  }

  function normalizeEmail(value) {
    return normalizeText(value);
  }

  function toFiniteNumber(value) {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function parse2925MainEmail(value) {
    const email = normalizeEmail(value);
    const match = email.match(/^([a-z0-9][a-z0-9._%+-]*)@(2925\.com)$/);
    if (!match) {
      return null;
    }

    return {
      domain: match[2],
      email,
      localPart: match[1],
    };
  }

  function normalize2925MainEmailCandidate(candidate, preferred = false) {
    if (!candidate) {
      return null;
    }

    const parsed = typeof candidate === 'string'
      ? parse2925MainEmail(candidate)
      : parse2925MainEmail(candidate.email || candidate.value || '');

    if (!parsed) {
      return null;
    }

    return {
      ...parsed,
      preferred: Boolean(candidate?.preferred ?? preferred),
    };
  }

  function extract2925EmailCandidates(text, options = {}) {
    const preferred = Boolean(options.preferred);
    const content = String(text || '');
    const matches = content.match(/[a-z0-9][a-z0-9._%+-]*@2925\.com/gi) || [];
    const seen = new Set();
    const candidates = [];

    for (const match of matches) {
      const candidate = normalize2925MainEmailCandidate(match, preferred);
      if (!candidate || seen.has(candidate.email)) {
        continue;
      }

      seen.add(candidate.email);
      candidates.push(candidate);
    }

    return candidates;
  }

  function select2925MainEmailCandidate(candidates = []) {
    const normalized = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const normalizedCandidate = normalize2925MainEmailCandidate(candidate, candidate?.preferred);
      if (!normalizedCandidate || seen.has(normalizedCandidate.email)) {
        continue;
      }

      seen.add(normalizedCandidate.email);
      normalized.push(normalizedCandidate);
    }

    if (normalized.length === 0) {
      return null;
    }

    const preferredCandidate = normalized.find((candidate) => candidate.preferred);
    if (preferredCandidate) {
      return {
        ...preferredCandidate,
        detectionMode: 'preferred',
      };
    }

    return {
      ...normalized[0],
      detectionMode: 'fallback',
    };
  }

  function detect2925MainEmailFromPageSnapshot(snapshot = {}) {
    const preferredTexts = Array.isArray(snapshot.preferredTexts) ? snapshot.preferredTexts : [];
    const fallbackTexts = Array.isArray(snapshot.fallbackTexts) ? snapshot.fallbackTexts : [];
    const candidates = [];

    for (const text of preferredTexts) {
      candidates.push(...extract2925EmailCandidates(text, { preferred: true }));
    }

    for (const text of fallbackTexts) {
      candidates.push(...extract2925EmailCandidates(text));
    }

    return select2925MainEmailCandidate(candidates);
  }

  function createRandomSuffix(randomFn = Math.random, length = 6) {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    let suffix = '';

    for (let index = 0; index < length; index += 1) {
      const randomValue = Math.max(0, Math.min(0.999999999999, Number(randomFn())));
      suffix += alphabet[Math.floor(randomValue * alphabet.length)] || alphabet[0];
    }

    return suffix;
  }

  function build2925ChildEmail(mainEmail, randomFn = Math.random) {
    const parsed = parse2925MainEmail(mainEmail);
    if (!parsed) {
      return null;
    }

    const suffix = createRandomSuffix(randomFn);
    return {
      childEmail: `${parsed.localPart}${suffix}@${parsed.domain}`,
      mainEmail: parsed.email,
      mainLocalPart: parsed.localPart,
      suffix,
    };
  }

  function is2925ChildEmailForMain(childEmail, mainEmail) {
    const parsedChild = parse2925MainEmail(childEmail);
    const parsedMain = parse2925MainEmail(mainEmail);

    if (!parsedChild || !parsedMain) {
      return false;
    }

    return parsedChild.domain === parsedMain.domain
      && parsedChild.localPart.startsWith(parsedMain.localPart)
      && parsedChild.localPart.length > parsedMain.localPart.length;
  }

  function parse2925Timestamp(value) {
    const normalized = normalizeWhitespace(value);
    const referenceDate = arguments.length > 1 && arguments[1] instanceof Date
      ? arguments[1]
      : new Date();

    if (normalized === '刚刚') {
      const currentTimestamp = referenceDate.getTime();
      return Number.isFinite(currentTimestamp) ? currentTimestamp : null;
    }

    const match = normalized.match(
      /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
    );
    if (!match) {
      const relativeMatch = normalized.match(/^(今天|昨天|昨日)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (!relativeMatch) {
        return null;
      }

      const [, dayLabel, hour, minute, second = '0'] = relativeMatch;
      const baseDate = new Date(referenceDate.getTime());
      baseDate.setMilliseconds(0);
      baseDate.setSeconds(Number(second));
      baseDate.setMinutes(Number(minute));
      baseDate.setHours(Number(hour));

      if (dayLabel === '昨天' || dayLabel === '昨日') {
        baseDate.setDate(baseDate.getDate() - 1);
      }

      const relativeTimestamp = baseDate.getTime();
      return Number.isFinite(relativeTimestamp) ? relativeTimestamp : null;
    }

    const [, year, month, day, hour, minute, second = '0'] = match;
    const timestamp = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ).getTime();

    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function matches2925InboxTargetEmail(text, targetEmail) {
    const content = normalizeText(text);
    const normalizedTarget = normalizeEmail(targetEmail);
    if (!content || !normalizedTarget) {
      return false;
    }

    const encodedTarget = normalizedTarget.replace('@', '=');
    return content.includes(normalizedTarget) || content.includes(encodedTarget);
  }

  function extractVerificationCode(text) {
    const content = String(text || '');

    const matchCn = content.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
    if (matchCn) return matchCn[1];

    const matchEn = content.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
    if (matchEn) return matchEn[1] || matchEn[2];

    const match6 = content.match(/\b(\d{6})\b/);
    if (match6) return match6[1];

    return null;
  }

  function build2925SyntheticMessageId(message = {}) {
    const matchedEmail = normalizeEmail(message?.matchedEmail || message?.toEmail || '');
    const timestampText = normalizeWhitespace(message?.timestampText || '');
    const subject = normalizeWhitespace(message?.subject || '');

    return `${matchedEmail}|${timestampText}|${subject}`;
  }

  function build2925MessageFromRowSnapshot(snapshot = {}, options = {}) {
    const sender = normalizeWhitespace(snapshot.sender || '');
    const senderDetail = normalizeWhitespace(snapshot.senderDetail || '');
    const subject = normalizeWhitespace(snapshot.subject || '');
    const preview = normalizeWhitespace(snapshot.preview || '');
    const rawText = normalizeWhitespace(snapshot.rawText || '');
    const combinedText = combineDistinctTextParts([sender, senderDetail, subject, preview, rawText]);
    const targetEmail = normalizeEmail(options.targetEmail || '');
    const matchedEmail = matches2925InboxTargetEmail(combinedText, targetEmail)
      ? targetEmail
      : normalizeEmail(snapshot.matchedEmail || snapshot.toEmail || '');
    const timestampText = normalizeWhitespace(snapshot.timestampText || '');
    const emailTimestamp = toFiniteNumber(snapshot.emailTimestamp)
      || parse2925Timestamp(timestampText, options.referenceDate);

    return {
      combinedText,
      emailTimestamp: emailTimestamp || 0,
      matchedEmail,
      messageId: snapshot.messageId ?? build2925SyntheticMessageId({
        matchedEmail,
        subject,
        timestampText,
      }),
      sender: normalizeText(`${sender} ${senderDetail}`),
      subject: subject || null,
      timestampText,
    };
  }

  function compareMessageIds(left, right) {
    const leftNumber = toFiniteNumber(left);
    const rightNumber = toFiniteNumber(right);

    if (leftNumber !== null && rightNumber !== null) {
      return rightNumber - leftNumber;
    }

    return String(right || '').localeCompare(String(left || ''));
  }

  function select2925VerificationMessage(messages = [], options = {}) {
    const allowExistingMessages = options.allowExistingMessages !== false;
    const existingMessageIds = options.existingMessageIds instanceof Set
      ? options.existingMessageIds
      : new Set(options.existingMessageIds || []);
    const filterAfterTimestamp = toFiniteNumber(options.filterAfterTimestamp) || 0;
    const senderFilters = (options.senderFilters || []).map(normalizeText);
    const subjectFilters = (options.subjectFilters || []).map(normalizeText);
    const targetEmail = normalizeEmail(options.targetEmail || '');
    const candidates = [];

    for (const message of messages) {
      const matchedEmail = normalizeEmail(message?.matchedEmail || message?.toEmail || '');
      if (targetEmail && matchedEmail !== targetEmail) {
        continue;
      }

      const subject = normalizeWhitespace(message?.subject || '');
      const combinedText = normalizeWhitespace(message?.combinedText || '');
      const sender = normalizeText(message?.sender || '');
      const searchText = normalizeText(`${subject} ${combinedText}`);
      const code = extractVerificationCode(`${subject} ${combinedText}`);
      const messageId = message?.messageId ?? build2925SyntheticMessageId(message);

      if (!code) {
        continue;
      }

      if (!allowExistingMessages && existingMessageIds.has(messageId)) {
        continue;
      }

      const senderMatch = senderFilters.length === 0
        || senderFilters.some((filter) => sender.includes(filter) || searchText.includes(filter));
      const subjectMatch = subjectFilters.length === 0
        || subjectFilters.some((filter) => normalizeText(subject).includes(filter) || searchText.includes(filter));

      if (!senderMatch && !subjectMatch) {
        continue;
      }

      const emailTimestamp = toFiniteNumber(message?.emailTimestamp)
        || parse2925Timestamp(message?.timestampText || '');

      if (filterAfterTimestamp > 0 && (!emailTimestamp || emailTimestamp <= filterAfterTimestamp)) {
        continue;
      }

      candidates.push({
        code,
        emailTimestamp: emailTimestamp || 0,
        matchedEmail,
        messageId,
        subject: subject || null,
      });
    }

    candidates.sort((left, right) => {
      if (left.emailTimestamp !== right.emailTimestamp) {
        return right.emailTimestamp - left.emailTimestamp;
      }

      return compareMessageIds(left.messageId, right.messageId);
    });

    return candidates[0] || null;
  }

  const api = {
    build2925MessageFromRowSnapshot,
    build2925ChildEmail,
    build2925SyntheticMessageId,
    createRandomSuffix,
    detect2925MainEmailFromPageSnapshot,
    extract2925EmailCandidates,
    extractVerificationCode,
    is2925ChildEmailForMain,
    matches2925InboxTargetEmail,
    parse2925MainEmail,
    parse2925Timestamp,
    select2925MainEmailCandidate,
    select2925VerificationMessage,
  };

  globalScope.MultiPage2925Mail = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
