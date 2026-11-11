/**
 * دالة التحقق من بيانات تسجيل الدخول (رقم الموظف والـ PIN)
 */



/**
 * دالة مساعدة لتشغيل كود بداخل قفل مؤقت قصير ومنع تداخل العمليات
 */


// Cached parsed Items table. Keeps item IDs hidden for UI but available for server validation.


// Cached parsed Item_Units table, grouped by item_id for fast validation and dropdown construction.


// Cached parsed branches table, with both ID and Arabic-name indexes.


// Cached parsed Suppliers table, grouped for active checks and dropdown loading.


// Cached parsed Supplier_Items table, grouped by supplier for fast purchase filtering.


// Cached parsed Allowed_Local_Purchases table, grouped by branch for local-purchase rules.


const MANAGER_PENDING_TRANSFERS_SCAN_LIMIT = 3000;
const MANAGER_TODAY_PURCHASES_SCAN_LIMIT = 5000;
const OWNER_PURCHASES_RECENT_SCAN_LIMIT = 5000;
const OWNER_TRANSFERS_RECENT_SCAN_LIMIT = 5000;
const OWNER_RAW_REPORT_MAX_DAYS = 31;
const MOVEMENT_BACKFILL_DEFAULT_MAX_ROWS = 2000;
const MOVEMENT_BACKFILL_RUNTIME_BUDGET_MS = 240000;
const BALANCE_CURRENT_RECENT_SCAN_LIMIT = 5000;
const BALANCE_RUN_LOG_RECENT_SCAN_LIMIT = 1000;
const BALANCE_HISTORICAL_RECENT_SCAN_LIMIT = 10000;


/**
 * دالة مساعدة لتسجيل الأحداث في جدول الـ Logs تلقائياً
 */


/**
 * الدالة الأساسية لتشغيل وتوليد واجهة الويب
 */

/**
 * دالة توافقية: توحيد كل المصادقة على verifyLogin لمنع تشتت المنطق
 * ملاحظة: الدالة الأساسية موجودة في auth.gs
 */

/**
 * دالة جلب قائمة المنتجات والوحدات الخاصة بكل منتج بناءً على جداول Items و Item_Units
 * تُستدعى عند فتح واجهة الموزع أو الفرع لبناء القوائم المنسدلة (Dropdowns) تلقائياً
 */


/**
 * دالة جلب الفروع النشطة من جدول branches بشكل ديناميكي
 * تعيد مصفوفة كائنات بالشكل: [{id: "...", name: "..."}]
 */


/**
 * دالة المحرك الخلفي: حساب الكمية المعيارية الموحدة بناءً على وحدة القياس
 * ترجع الرقم النهائي الصغير المستهدف للحفظ في قاعدة البيانات
 */


/**
 * تحميل أولي موحد حسب دور المستخدم لتقليل عدد استدعاءات google.script.run بعد الدخول.
 * يستخدم نفس بوابة الجلسة والصلاحيات الحالية، ولا يغير الدوال القديمة حفاظاً على التوافق.
 */


/**
 * دالة حفظ الشحنة المجمعة في جدول Transfers
 * تستقبل مصفوفة من المواد (items) وبيانات الشحنة العامة
 */



/**
 * دالة جلب الشحنات المعلقة الخاصة بفرع معين فقط
 * تُستدعى فور دخول مدير الفرع لملء لوحة التحكم الخاصة به
 */



/**
 * دالة معالجة استلام الشحنة وتحديث السجلات في الـ Google Sheet
 * تستقبل مصفوفة المواد بعد الفحص والتعديل الميداني من مدير الفرع
 */

/**
 * دالة حفظ المشتريات المحلية اليومية للفرع في جدول Purchases
 * تعتمد على محرك تحويل الوحدات لحساب الكمية المعيارية قبل الحفظ
 */


/**
 * دالة التحقق من حالة الموظف (نشط أم معطل/مجمد)
 */

function withShortScriptLock_(timeoutMs, callback) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lock.waitLock(timeoutMs || 5000);
    lockAcquired = true;
    return callback();
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function normalizeDigits_(value) {
  return String(value || "")
    .replace(/[٠-٩]/g, function(d) { return "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
    .replace(/[۰-۹]/g, function(d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
    .trim();
}

function normalizePin_(pin) {
  const pinStr = normalizeDigits_(pin);
  if (!/^\d+$/.test(pinStr)) return "";
  const normalized = pinStr.length < 4 ? pinStr.padStart(4, "0") : pinStr;
  return /^\d{4}$/.test(normalized) ? normalized : "";
}

function normalizeEmployeeNumber_(employeeNumber) {
  return normalizeDigits_(employeeNumber);
}

function normalizeRole_(role) {
  return String(role || "").trim().toLowerCase();
}

function preserveSheetText_(value, defaultValue) {
  if (value === null || value === undefined || value === "") {
    return defaultValue === undefined ? "" : String(defaultValue);
  }
  return String(value).trim();
}

function parseSheetNumber_(value, defaultValue) {
  if (value === null || value === undefined || value === "") {
    return defaultValue === undefined ? 0 : defaultValue;
  }
  const parsed = Number(normalizeDigits_(value));
  return isNaN(parsed) ? (defaultValue === undefined ? 0 : defaultValue) : parsed;
}

function parseNumericInput_(value) {
  return parseFloat(normalizeDigits_(value));
}

function parseCostInput_(value, required) {
  const rawValue = value === 0 ? "0" : normalizeDigits_(value);
  if (rawValue === "") {
    if (required) {
      throw new Error("التكلفة مطلوبة للموزع.");
    }
    return 0;
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(rawValue)) {
    throw new Error("القيمة يجب أن تكون صفر أو أكثر.");
  }
  const parsed = Number(rawValue);
  if (!isFinite(parsed) || parsed < 0) {
    throw new Error("القيمة يجب أن تكون صفر أو أكثر.");
  }
  return parsed;
}

function parseReceiptQuantityInput_(value) {
  const rawValue = value === 0 ? "0" : normalizeDigits_(value);
  if (rawValue === "") {
    throw new Error("بيانات الاستلام غير صالحة في أحد الأسطر.");
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(rawValue)) {
    throw new Error("بيانات الاستلام غير صالحة في أحد الأسطر.");
  }
  const parsed = Number(rawValue);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error("بيانات الاستلام غير صالحة في أحد الأسطر.");
  }
  return parsed;
}

function getSafeWriteErrorMessage_(error) {
  const genericMessage = "تعذر حفظ العملية حالياً. يرجى المحاولة مرة أخرى.";
  const message = error && error.message ? String(error.message) : "";
  if (!message) return genericMessage;

  if (message === "انتهت صلاحية بيانات الاستلام. الرجاء تحديث الشاشة والمحاولة مجدداً." ||
      message === "بيانات الاستلام غير صالحة. الرجاء تحديث الشاشة والمحاولة مجدداً.") {
    return "بيانات الاستلام لم تعد صالحة، ولم يُحفظ الاستلام. دوّن الكميات والوحدات وأسباب الفرق والملاحظات، ثم حدّث الصفحة وسجّل الدخول إذا طُلب منك. أعد إدخال القيم وراجع الشحنة قبل اعتمادها.";
  }

  const allowedMessages = [
    "التكلفة مطلوبة للموزع.",
    "القيمة يجب أن تكون صفر أو أكثر.",
    "يجب إضافة مادة واحدة على الأقل قبل حفظ المشتريات.",
    "الصنف المحدد غير موجود في بيانات المنتجات.",
    "الوحدة المحددة غير صالحة لهذا الصنف.",
    "يجب أن تكون الكمية المشتراة أكبر من الصفر.",
    "هذا الصنف غير مصرح للشراء المحلي في هذا الفرع.",
    "هذا المورد غير مصرح له ببيع المادة المحددة.",
    "المورد المحدد غير نشط أو غير موجود.",
    "بيانات الاستلام غير صالحة في أحد الأسطر.",
    "الوحدة المستلمة غير صالحة في أحد الأسطر.",
    "يجب تحديد سبب الفرق (نقص/زيادة) لكل سطر غير مطابق.",
    "تم إرسال نفس سطر الاستلام أكثر من مرة. الرجاء تحديث الشاشة.",
    "لا يمكن اعتماد شحنة لا تخص فرع الموظف الحالي.",
    "لا يمكن تعديل شحنة تمت معالجتها مسبقاً.",
    "تعذر العثور على سطر الشحنة المعلقة. الرجاء تحديث الشاشة لأن الشحنة قد تكون عولجت أو تغيرت.",
    "تعذر تحديد سطر الشحنة بدقة بسبب وجود أكثر من سطر مطابق. الرجاء مراجعة الإدارة.",
    "تعذر تحديد فرع المدير الحالي.",
    "تعذر تحديد فرع الموظف لمعالجة الاستلام.",
    "لا يمكن إرسال تحويل إلى نفس فرع المدير.",
    "الفرع غير نشط حالياً."
  ];

  return allowedMessages.indexOf(message) !== -1 ? message : genericMessage;
}

function parseSheetDate_(value) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  const text = String(value || "").trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const parsed = new Date(
      parseInt(match[1], 10),
      parseInt(match[2], 10) - 1,
      parseInt(match[3], 10),
      parseInt(match[4] || "0", 10),
      parseInt(match[5] || "0", 10),
      parseInt(match[6] || "0", 10)
    );
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const isoDate = new Date(text);
    return isNaN(isoDate.getTime()) ? null : isoDate;
  }

  return null;
}

function parseDateInputStart_(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = parseSheetDate_(text);
  if (!parsed) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function parseDateToExclusive_(dateTo) {
  const start = parseDateInputStart_(dateTo);
  if (!start) return null;
  const exclusive = new Date(start.getTime());
  exclusive.setDate(exclusive.getDate() + 1);
  return exclusive;
}

function resolveOwnerReportDateRange_(filters) {
  const input = filters || {};
  const timezone = Session.getScriptTimeZone();
  const todayText = Utilities.formatDate(new Date(), timezone, "yyyy-MM-dd");
  let dateFromText = normalizeDigits_(input.dateFrom || "");
  let dateToText = normalizeDigits_(input.dateTo || "");
  const originalDateFromText = dateFromText;
  const originalDateToText = dateToText;
  let isDefaulted = false;

  function parseOwnerReportDateStart_(value, label) {
    const text = normalizeDigits_(value || "");
    if (!text) return null;
    const parsed = parseDateInputStart_(text);
    if (!parsed) {
      throw new Error("تاريخ " + label + " غير صحيح.");
    }
    const exactDateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (exactDateMatch) {
      const normalizedParsed = Utilities.formatDate(parsed, timezone, "yyyy-MM-dd");
      if (normalizedParsed !== text) {
        throw new Error("تاريخ " + label + " غير صحيح.");
      }
    }
    return parsed;
  }

  function nextDayText_(value, label) {
    const start = parseOwnerReportDateStart_(value, label || "النهاية");
    const next = new Date(start.getTime());
    next.setDate(next.getDate() + 1);
    return Utilities.formatDate(next, timezone, "yyyy-MM-dd");
  }

  if (!dateFromText && !dateToText) {
    dateFromText = todayText;
    dateToText = todayText;
    isDefaulted = true;
  } else if (dateFromText && !dateToText) {
    dateToText = dateFromText;
  } else if (!dateFromText && dateToText) {
    dateFromText = dateToText;
  }

  const dateFromLabel = originalDateFromText || !originalDateToText ? "البداية" : "النهاية";
  const dateFromStart = parseOwnerReportDateStart_(dateFromText, dateFromLabel);
  const dateToExclusive = parseDateToExclusive_(dateToText);
  if (!dateToExclusive) {
    throw new Error("تاريخ النهاية غير صحيح.");
  }
  const exactToDateMatch = dateToText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exactToDateMatch) {
    const expectedNextDay = nextDayText_(dateToText, "النهاية");
    const actualNextDay = Utilities.formatDate(dateToExclusive, timezone, "yyyy-MM-dd");
    if (actualNextDay !== expectedNextDay) {
      throw new Error("تاريخ النهاية غير صحيح.");
    }
  }
  if (dateFromStart && dateToExclusive && dateFromStart >= dateToExclusive) {
    throw new Error("نطاق التاريخ غير صحيح.");
  }

  return {
    dateFromStart: dateFromStart,
    dateToExclusive: dateToExclusive,
    dateFromText: dateFromText,
    dateToText: dateToText,
    isDefaulted: isDefaulted
  };
}

function formatDateTimeForClient_(value) {
  const dateValue = parseSheetDate_(value);
  if (!dateValue) return "";
  return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
}

function getCurrentInventoryPeriod_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
}

function normalizeInventoryPeriodValue_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM");
  }

  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}$/.test(text)) return text;

  const parsedDate = parseSheetDate_(text);
  if (parsedDate) {
    return Utilities.formatDate(parsedDate, Session.getScriptTimeZone(), "yyyy-MM");
  }

  const numericValue = Number(text);
  if (isFinite(numericValue) && numericValue > 20000) {
    const sheetSerialDate = new Date(1899, 11, 30);
    sheetSerialDate.setDate(sheetSerialDate.getDate() + Math.floor(numericValue));
    return Utilities.formatDate(sheetSerialDate, Session.getScriptTimeZone(), "yyyy-MM");
  }

  return text;
}

function normalizeHeaderName_(value) {
  return String(value || "").trim().toLowerCase();
}

function getExactTextMatchedRowNumbers_(sheet, column, textValue) {
  const target = String(textValue || "").trim();
  if (!sheet || !column || !target || sheet.getLastRow() < 2) return [];
  const range = sheet.getRange(2, column, sheet.getLastRow() - 1, 1);
  const finder = range.createTextFinder(target).matchEntireCell(true).matchCase(true);
  if (typeof finder.useRegularExpression === "function") {
    finder.useRegularExpression(false);
  }
  const matches = finder.findAll() || [];
  return matches.map(function(cell) {
    return cell.getRow();
  });
}

function ensureInventoryEnhancementSchema_() {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lock.waitLock(15000);
    lockAcquired = true;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (inventorySubmissionGate_()) return {success:true, changed:false, deferred:true};
    const requirements = getInventorySchemaRequirements_();
    const result = { success: true, message: "تم تحديث هيكل الجداول بنجاح.", createdSheets: [], addedHeaders: [], migratedRows: 0 };
    
    // 1 & 2. Create missing sheets and add missing headers
    Object.keys(requirements).forEach(function(sheetName) {
      let sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (!sheet) {
        sheet = ss.insertSheet(sheetName);
        result.createdSheets.push(sheetName);
      }
      
      const requiredHeaders = requirements[sheetName];
      const headerMap = getHeaderMap_(sheet);
      const newHeaders = [];
      
      requiredHeaders.forEach(function(reqHeader) {
        if (!getHeaderIndexWithAliases_(headerMap, sheetName, reqHeader)) {
          newHeaders.push(reqHeader);
        }
      });
      
      if (newHeaders.length > 0) {
        const startCol = Math.max(1, sheet.getLastColumn() + 1);
        sheet.getRange(1, startCol, 1, newHeaders.length).setValues([newHeaders]);
        result.addedHeaders.push({ sheet: sheetName, headers: newHeaders });
      }
    });
    
    // 3. Backfill and repair Transfers source_branch from the creator role
    const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
    if (transfersSheet && transfersSheet.getLastRow() > 1) {
      const headerMap = getHeaderMap_(transfersSheet);
      const sourceBranchCol = getHeaderIndexWithAliases_(headerMap, "Transfers", "source_branch");
      const createdByCol = getHeaderIndexWithAliases_(headerMap, "Transfers", "created_by");
      if (sourceBranchCol > 0 && createdByCol > 0) {
        const dataRange = transfersSheet.getRange(2, sourceBranchCol, transfersSheet.getLastRow() - 1, 1);
        const values = dataRange.getValues();
        const createdByValues = transfersSheet.getRange(2, createdByCol, transfersSheet.getLastRow() - 1, 1).getValues();
        const transferIdColumn = getHeaderIndex_(headerMap, 'transfer_id');
        const transferIds = transferIdColumn ? transfersSheet.getRange(2,transferIdColumn,transfersSheet.getLastRow()-1,1).getValues() : [];
        const usersIndex = getUsersIndex_(ss);
        const sourceBranchDiagnostics = {
          preservedExistingBranch: 0,
          filledManagerBlankRows: 0,
          repairedManagerDistributorRows: 0,
          resolvedDistributorRows: 0,
          ambiguousRows: 0
        };
        let modified = false;
        for (let i = 0; i < values.length; i++) {
          if (/^TRF-inv-[a-f0-9]{32}$/.test(String((transferIds[i] || [])[0] || ''))) continue;
          const currentSourceBranch = String(values[i][0] || "").trim();
          if (currentSourceBranch === "" || currentSourceBranch === "DISTRIBUTOR") {
            const resolvedSourceBranch = resolveTransferSourceBranchForMigration_(
              usersIndex,
              createdByValues[i][0],
              currentSourceBranch,
              sourceBranchDiagnostics
            );
            if (resolvedSourceBranch !== currentSourceBranch) {
              values[i][0] = resolvedSourceBranch;
              modified = true;
              result.migratedRows++;
            }
          }
        }
        result.sourceBranchDiagnostics = sourceBranchDiagnostics;
        if (modified) {
          bumpBalanceSourceVersion_();
          dataRange.setValues(values);
        }
      } else if (sourceBranchCol > 0) {
        result.sourceBranchDiagnostics = {
          ambiguousRows: transfersSheet.getLastRow() - 1,
          message: "created_by header missing; source_branch backfill skipped"
        };
      }
    }
    
    return result;
  } catch (e) {
    console.error("ensureInventoryEnhancementSchema_ failed", e);
    return { success: false, message: "تعذر تجهيز بنية جداول النظام حالياً." };
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function ensureRuntimeSchemaReady_() {
  if (inventorySubmissionGate_()) return {success:true, changed:false, deferred:true};
  const cache = CacheService.getScriptCache();
  const cacheKey = "runtime_schema_ready_v5";
  try {
    if (cache.get(cacheKey) === "ready") {
      return { success: true, changed: false, cached: true };
    }
  } catch (e) {
    // Cache misses/failures should not block the runtime schema check.
  }

  const migration = ensureInventoryEnhancementSchema_();
  if (!migration || !migration.success) {
    throw new Error(migration && migration.message ? migration.message : "تعذر تجهيز بنية جداول النظام.");
  }

  if (migration.deferred) return migration;
  const changed = (migration.createdSheets && migration.createdSheets.length > 0) ||
    (migration.addedHeaders && migration.addedHeaders.length > 0) ||
    migration.migratedRows > 0;

  if (changed) {
    const cacheClearResult = clearReferenceCache_();
    if (!cacheClearResult || !cacheClearResult.success) {
      throw new Error(cacheClearResult && cacheClearResult.message ? cacheClearResult.message : "تعذر تحديث ذاكرة البيانات المرجعية بعد الهجرة.");
    }
    try {
      rebuildReferenceData_(SpreadsheetApp.getActiveSpreadsheet());
    } catch (e) {
      console.error("ensureRuntimeSchemaReady_ reference rebuild failed", e);
      throw new Error("تم تحديث بنية الجداول لكن تعذر إعادة بناء ذاكرة البيانات المرجعية حالياً.");
    }
  }

  try {
    cache.put(cacheKey, "ready", 600);
  } catch (e) {
    // The schema is ready even if the readiness marker cannot be cached.
  }

  return { success: true, changed: changed, cached: false, migration: migration };
}

function stringifyLogDetails_(details) {
  if (details === null || details === undefined) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch (e) {
    return String(details);
  }
}

function ensureLogDetailHeaders_(logsSheet) {
  if (!logsSheet) return null;
  const requiredHeaders = ["log_id", "action", "user", "timestamp", "details", "entity_id", "entity_type"];
  let headerMap = getHeaderMap_(logsSheet);
  const missingHeaders = requiredHeaders.filter(function(headerName) {
    return !getHeaderIndex_(headerMap, headerName);
  });
  if (!missingHeaders.length) return headerMap;

  const startColumn = Math.max(1, logsSheet.getLastColumn() + 1);
  logsSheet.getRange(1, startColumn, 1, missingHeaders.length).setValues([missingHeaders]);
  return getHeaderMap_(logsSheet);
}

function findHeaderColumn_(headers, candidates, fallbackOneBased) {
  const normalizedCandidates = candidates.map(function(candidate) {
    return String(candidate || "").trim().toLowerCase();
  });
  for (let i = 0; i < headers.length; i++) {
    const header = String(headers[i] || "").trim().toLowerCase();
    if (normalizedCandidates.indexOf(header) !== -1) {
      return i + 1;
    }
  }
  return fallbackOneBased || 0;
}

function parseTransferCost_(item, options) {
  const requireCost = options && options.requireCost === true;
  const rawCost = item ? item.cost : null;
  return parseCostInput_(rawCost, requireCost);
}

function getRecentLogRows_(logsSheet, maxRows) {
  if (!logsSheet) return [];
  const lastRow = logsSheet.getLastRow();
  if (lastRow < 2) return [];
  const rowLimit = Math.max(1, parseInt(maxRows, 10) || 500);
  const startRow = Math.max(2, lastRow - rowLimit + 1);
  return logsSheet.getRange(startRow, 1, lastRow - startRow + 1, 4).getValues();
}

function getRecentSheetRows_(sheet, headerMap, maxRowsToScan) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { startRow: 2, values: [] };
  const dataRows = lastRow - 1;
  const rowsToRead = Math.min(dataRows, maxRowsToScan || 2000);
  const startRow = lastRow - rowsToRead + 1;
  return {
    startRow: startRow,
    values: sheet.getRange(startRow, 1, rowsToRead, headerMap.__lastColumn).getValues()
  };
}

// Canonical logical identity for one Movement_Daily_Summary row:
//   summary_date | branch_id | item_id | source_type | movement_type
//
// summary_date must be canonicalized by TYPE, not by String(): writers store
// the "yyyy-MM-dd" text produced by formatMovementSummaryDate_, while a read
// back from a date-formatted cell returns a Date object. Comparing those with
// String() never matches, which made every incremental update append a second
// logical row instead of updating the existing one.
//
// Normalization rules:
//   - summary_date: Date objects, sheet serials, and ISO-like text all reduce
//     to "yyyy-MM-dd"; an unparseable value yields "" and marks the row
//     malformed.
//   - branch_id / item_id: whitespace-trimmed, case-sensitive. These are
//     externally supplied identifiers, so two ids differing only by case are
//     never silently merged.
//   - source_type / movement_type: whitespace-trimmed and lower-cased. These
//     are code-controlled enums ("purchase"/"transfer" and
//     "local_purchase"/"incoming_pending"/"incoming_received"/
//     "outgoing_branch_transfer"), so case folding cannot merge distinct facts.
//   - A key missing any component is not a valid identity; callers must treat
//     such a row as malformed rather than as a member of the key set.
function canonicalMovementSummaryDateKey_(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = parseSheetDate_(value);
  if (!parsed) return "";
  return formatMovementSummaryDate_(parsed);
}

function getMovementSummaryKey_(entry) {
  return [
    canonicalMovementSummaryDateKey_(entry.summary_date),
    String(entry.branch_id || "").trim(),
    String(entry.item_id || "").trim(),
    String(entry.source_type || "").trim().toLowerCase(),
    String(entry.movement_type || "").trim().toLowerCase()
  ].join("|");
}

function isCompleteMovementSummaryKey_(key) {
  const parts = String(key || "").split("|");
  if (parts.length !== 5) return false;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) return false;
  }
  return true;
}

function normalizeMovementSummaryEntry_(entry, now) {
  const sourceDate = parseSheetDate_(entry.last_source_updated_at) || now || new Date();
  // Always store the canonical "yyyy-MM-dd" text so a stored row and a freshly
  // built entry produce the same logical key on the next read.
  const summaryDate = canonicalMovementSummaryDateKey_(entry.summary_date) ||
    formatMovementSummaryDate_(sourceDate);
  return {
    summary_date: summaryDate,
    period_month: String(entry.period_month || summaryDate.substring(0, 7)).trim(),
    branch_id: String(entry.branch_id || "").trim(),
    item_id: String(entry.item_id || "").trim(),
    source_type: String(entry.source_type || "").trim().toLowerCase(),
    movement_type: String(entry.movement_type || "").trim().toLowerCase(),
    quantity_in: Number(entry.quantity_in || 0),
    quantity_out: Number(entry.quantity_out || 0),
    net_quantity: Number(entry.net_quantity || 0),
    purchase_count: Number(entry.purchase_count || 0),
    transfer_count: Number(entry.transfer_count || 0),
    pending_count: Number(entry.pending_count || 0),
    approved_count: Number(entry.approved_count || 0),
    missing_count: Number(entry.missing_count || 0),
    zero_receipt_count: Number(entry.zero_receipt_count || 0),
    total_cost: Number(entry.total_cost || 0),
    last_source_row: Number(entry.last_source_row || 0),
    last_source_updated_at: entry.last_source_updated_at || sourceDate,
    updated_at: now || new Date()
  };
}

function logAction_(action, user, logsSheet, timestamp) {
  if (!logsSheet) return;
  const logId = "LOG-" + timestamp.getTime() + "-" + Math.floor(Math.random() * 1000);
  logsSheet.getRange(logsSheet.getLastRow() + 1, 1, 1, 4).setValues([[logId, action, user, timestamp]]);
}

function logActionDetail_(action, user, details, logsSheet, timestamp) {
  if (!logsSheet) return;
  const logTime = timestamp || new Date();
  const logId = "LOG-" + logTime.getTime() + "-" + Math.floor(Math.random() * 1000);
  const headerMap = ensureLogDetailHeaders_(logsSheet);
  const lastColumn = logsSheet.getLastColumn();
  if (!headerMap || lastColumn < 4) {
    logsSheet.getRange(logsSheet.getLastRow() + 1, 1, 1, 4).setValues([[logId, action, user, logTime]]);
    return;
  }

  const detailText = stringifyLogDetails_(details);
  const row = new Array(headerMap.__lastColumn || lastColumn).fill("");
  const setValue = function(headerName, fallbackColumn, value) {
    const column = getHeaderIndex_(headerMap, headerName) || fallbackColumn;
    if (column > 0 && column <= row.length) row[column - 1] = value;
  };

  setValue("log_id", 1, logId);
  setValue("action", 2, action);
  setValue("user", 3, user);
  setValue("timestamp", 4, logTime);
  setValue("details", 0, detailText);
  if (details && typeof details === "object") {
    setValue("entity_id", 0, details.entityId || details.transferId || details.purchaseId || "");
    setValue("entity_type", 0, details.entityType || "");
  }

  logsSheet.getRange(logsSheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function tryLogCommittedAction_(action, user, details, logsSheet, timestamp) {
  try {
    if (!logsSheet) {
      throw new Error("Logs sheet unavailable for committed action audit.");
    }
    logActionDetail_(action, user, details, logsSheet, timestamp);
    return { success: true, warning: "" };
  } catch (error) {
    let diagnostic = {
      action: "",
      entityType: "",
      entityId: "",
      message: ""
    };
    try {
      diagnostic.action = String(action || "");
      diagnostic.entityType = String(details && details.entityType ? details.entityType : "");
      diagnostic.entityId = String(
        details && (details.entityId || details.transferId || details.purchaseId)
          ? (details.entityId || details.transferId || details.purchaseId)
          : ""
      );
      diagnostic.message = error && error.message ? String(error.message) : String(error || "");
    } catch (diagnosticBuildError) {
      diagnostic = { message: "Unable to serialize committed audit failure." };
    }
    try {
      console.error("Committed action audit logging failed", diagnostic);
    } catch (diagnosticLogError) {
      // The committed business write must not be changed into a failure by diagnostics.
    }
    return {
      success: false,
      warning: "تم حفظ العملية، لكن تعذر تسجيل سجل التدقيق حالياً. لا تعِد إرسال العملية."
    };
  }
}

function getSheetByNameCaseInsensitive_(ss, sheetName) {
  if (!ss || !sheetName) return null;
  let sheet = ss.getSheetByName(sheetName);
  if (sheet) return sheet;
  const lowerName = String(sheetName).toLowerCase();
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getName()).toLowerCase() === lowerName) return sheets[i];
  }
  return null;
}

function getOwnerDashboardBootstrap(sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const user = requireOwner_(ss, sessionToken);
  ensureRuntimeSchemaReady_();
  const branchesRes = getActiveBranchesForUser_(ss, user);
  return {
    success: true,
    branches: branchesRes.success ? branchesRes.branches : [],
    currentPeriodMonth: getCurrentInventoryPeriod_()
  };
}

function getOwnerSettingsClientDebugValue_(value) {
  if (value === null || typeof value === "undefined") return "";
  if (value instanceof Date) return formatDateTimeForClient_(value);
  return String(value);
}

function getOwnerSettingsData(sessionToken) {
  const checkpoints = ["START"];
  let ss = null;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    checkpoints.push("SPREADSHEET_READY");

    const user = requireOwner_(ss, sessionToken);
    checkpoints.push("OWNER_AUTH_READY");

    ensureRuntimeSchemaReady_();
    checkpoints.push("SCHEMA_READY");

    const branchesRes = getActiveBranchesForUser_(ss, user);
    const branches = branchesRes.success ? branchesRes.branches : [];
    checkpoints.push("BRANCHES_READY");

    let movementReadModel;
    try {
      movementReadModel = getMovementReadModelHealth_(ss);
      checkpoints.push("MOVEMENT_HEALTH_READY");
    } catch (e) {
      console.error("getOwnerSettingsData movement health failed", {
        message: e && e.message ? String(e.message) : String(e || "")
      });
      movementReadModel = getOwnerMovementReadModelFallback_();
      checkpoints.push("MOVEMENT_HEALTH_FALLBACK");
    }

    let branchSettings;
    try {
      branchSettings = getOwnerBranchSettings_(ss, branches);
      checkpoints.push("BRANCH_SETTINGS_READY");
    } catch (e) {
      console.error("getOwnerSettingsData branch settings failed", {
        branchCount: branches.length,
        message: e && e.message ? String(e.message) : String(e || "")
      });
      checkpoints.push("BRANCH_SETTINGS_FALLBACK");
      return buildOwnerSettingsFailureResponse_("BRANCH_SETTINGS_FAILED", checkpoints);
    }

    checkpoints.push("RETURN_SUCCESS");
    return {
      success: true,
      branches: branches,
      movementReadModel: movementReadModel,
      branchSettings: branchSettings,
      patchVersion: OWNER_SETTINGS_PATCH_VERSION_,
      diagnosticCode: "",
      checkpoints: checkpoints
    };
  } catch (e) {
    console.error("getOwnerSettingsData failed", {
      checkpoints: checkpoints,
      message: e && e.message ? String(e.message) : String(e || "")
    });
    let diagnosticCode = "OWNER_SETTINGS_FAILED";
    if (checkpoints.indexOf("SPREADSHEET_READY") === -1) {
      diagnosticCode = "SPREADSHEET_FAILED";
    } else if (checkpoints.indexOf("OWNER_AUTH_READY") === -1) {
      diagnosticCode = "OWNER_AUTH_FAILED";
    } else if (checkpoints.indexOf("SCHEMA_READY") === -1) {
      diagnosticCode = "SCHEMA_FAILED";
    } else if (checkpoints.indexOf("BRANCHES_READY") === -1) {
      diagnosticCode = "BRANCHES_FAILED";
    }
    return buildOwnerSettingsFailureResponse_(diagnosticCode, checkpoints);
  }
}

function getOwnerMovementReadModelFallback_() {
  return {
    checkedAt: formatDateTimeForClient_(new Date()),
    summariesReady: false,
    pendingIndexReady: false,
    summaryRows: 0,
    pendingIndexRows: 0,
    purchaseRows: 0,
    transferRows: 0,
    coverageReliable: false,
    maxPurchaseSummarySourceRow: 0,
    maxTransferSummarySourceRow: 0,
    maxPendingIndexTransferRow: 0,
    purchaseRowsAfterSummaryCursor: "",
    transferRowsAfterSummaryCursor: "",
    pendingTransferRowsAfterIndexCursor: "",
    lastSummaryUpdate: "",
    rowsRequiringBackfill: "",
    message: "تعذر فحص ملخصات الحركة حالياً. إعدادات الجرد ما زالت متاحة.",
    archiveDiagnostics: {
      ready: false,
      rows: 0,
      message: "تعذر فحص حالة الأرشفة حالياً."
    }
  };
}

function getOwnerDashboardData(branchId, dateFrom, dateTo, sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const user = requireOwner_(ss, sessionToken);
  ensureRuntimeSchemaReady_();
  
  const branchesRes = getActiveBranchesForUser_(ss, user);
  const branches = branchesRes.success ? branchesRes.branches : [];
  const purchasesRes = getOwnerPurchases(branchId, dateFrom, dateTo, sessionToken);
  const transfersRes = getOwnerTransfers(branchId, dateFrom, dateTo, sessionToken);
  return {
    success: true,
    branches: branches,
    purchases: purchasesRes.purchases || [],
    transfers: transfersRes.transfers || [],
    purchasesMeta: {
      message: purchasesRes.message || "",
      usedSummary: purchasesRes.usedSummary === true,
      usedRawRows: purchasesRes.usedRawRows === true,
      scanLimited: purchasesRes.scanLimited === true,
      scannedRows: purchasesRes.scannedRows || 0,
      totalRows: purchasesRes.totalRows || 0
    },
    transfersMeta: {
      message: transfersRes.message || "",
      usedSummary: transfersRes.usedSummary === true,
      usedRawRows: transfersRes.usedRawRows === true,
      scanLimited: transfersRes.scanLimited === true,
      scannedRows: transfersRes.scannedRows || 0,
      totalRows: transfersRes.totalRows || 0
    },
    movementReadModel: getMovementReadModelHealth_(ss),
    featureVisibility: branchId ? getFeatureVisibility(branchId, sessionToken).visibility : {},
    branchSettings: getOwnerBranchSettings_(ss, branches)
  };
}

function getArchiveDryRunCutoffDate_() {
  const timezone = Session.getScriptTimeZone();
  const todayText = Utilities.formatDate(new Date(), timezone, "yyyy-MM-dd");
  const parts = todayText.split("-");
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  return new Date(year, monthIndex - 1, 1);
}

function getEmptyArchiveDryRunSheetResult_(sheetName, message) {
  return {
    sheetName: sheetName,
    totalRows: 0,
    eligibleRows: 0,
    blockedRows: 0,
    blockedPendingRows: 0,
    blockedUnknownStatusRows: 0,
    blockedInvalidDateRows: 0,
    oldestEligibleDate: "",
    newestEligibleDate: "",
    message: message || ""
  };
}

function updateArchiveEligibleDateRange_(result, dateValue) {
  if (!result || !dateValue) return;
  if (!result._oldestEligibleDateValue || dateValue.getTime() < result._oldestEligibleDateValue.getTime()) {
    result._oldestEligibleDateValue = dateValue;
  }
  if (!result._newestEligibleDateValue || dateValue.getTime() > result._newestEligibleDateValue.getTime()) {
    result._newestEligibleDateValue = dateValue;
  }
}

function finalizeArchiveDryRunSheetResult_(result) {
  if (!result) return result;
  result.oldestEligibleDate = result._oldestEligibleDateValue ? formatDateTimeForClient_(result._oldestEligibleDateValue) : "";
  result.newestEligibleDate = result._newestEligibleDateValue ? formatDateTimeForClient_(result._newestEligibleDateValue) : "";
  delete result._oldestEligibleDateValue;
  delete result._newestEligibleDateValue;
  return result;
}

function scanArchiveDateOnlySheet_(ss, sheetName, dateHeader, cutoffDate, missingMessage, diagnosticOnly) {
  const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
  if (!sheet) return getEmptyArchiveDryRunSheetResult_(sheetName, missingMessage || ("جدول " + sheetName + " غير موجود."));
  const headerMap = sheetName === "Logs" ? getHeaderMap_(sheet) : requireHeaderColumns_(sheet, getInventorySchemaRequirements_()[sheetName]);
  if (!getHeaderIndex_(headerMap, dateHeader)) {
    const resultMissingDateHeader = getEmptyArchiveDryRunSheetResult_(sheetName, "عمود التاريخ " + dateHeader + " غير موجود.");
    resultMissingDateHeader.totalRows = Math.max(0, sheet.getLastRow() - 1);
    resultMissingDateHeader.blockedRows = resultMissingDateHeader.totalRows;
    resultMissingDateHeader.blockedInvalidDateRows = resultMissingDateHeader.totalRows;
    return resultMissingDateHeader;
  }

  const totalRows = Math.max(0, sheet.getLastRow() - 1);
  const result = getEmptyArchiveDryRunSheetResult_(sheetName, diagnosticOnly ? "فحص تشخيصي فقط؛ لا يدخل في خطة تنفيذ الأرشفة القادمة." : "");
  result.totalRows = totalRows;
  if (totalRows < 1) return finalizeArchiveDryRunSheetResult_(result);

  const values = sheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowDate = parseSheetDate_(getCellByHeader_(values[i], headerMap, dateHeader));
    if (!rowDate) {
      result.blockedRows++;
      result.blockedInvalidDateRows++;
      continue;
    }
    if (rowDate < cutoffDate) {
      result.eligibleRows++;
      updateArchiveEligibleDateRange_(result, rowDate);
    }
  }
  return finalizeArchiveDryRunSheetResult_(result);
}

function scanArchiveTransfersSheet_(ss, cutoffDate) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  if (!sheet) return getEmptyArchiveDryRunSheetResult_("Transfers", "جدول Transfers غير موجود.");
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Transfers);
  const totalRows = Math.max(0, sheet.getLastRow() - 1);
  const result = getEmptyArchiveDryRunSheetResult_("Transfers", "");
  result.totalRows = totalRows;
  if (totalRows < 1) return finalizeArchiveDryRunSheetResult_(result);

  const values = sheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
    if (!createdAt) {
      result.blockedRows++;
      result.blockedInvalidDateRows++;
      continue;
    }
    if (createdAt >= cutoffDate) continue;

    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    if (status === "pending") {
      result.blockedRows++;
      result.blockedPendingRows++;
      continue;
    }
    if (status === "approved" || status === "missing") {
      result.eligibleRows++;
      updateArchiveEligibleDateRange_(result, createdAt);
      continue;
    }
    result.blockedRows++;
    result.blockedUnknownStatusRows++;
  }
  return finalizeArchiveDryRunSheetResult_(result);
}

function buildArchiveControlRowBySheetName_(archiveSheet, headerMap) {
  const rowsByName = {};
  const rowCount = Math.max(0, archiveSheet.getLastRow() - 1);
  if (rowCount < 1) return rowsByName;
  const values = archiveSheet.getRange(2, 1, rowCount, headerMap.__lastColumn).getValues();
  for (let i = 0; i < values.length; i++) {
    const sheetName = String(getCellByHeader_(values[i], headerMap, "sheet_name") || "").trim();
    if (sheetName && !rowsByName[sheetName]) rowsByName[sheetName] = i + 2;
  }
  return rowsByName;
}

function updateArchiveControlDryRunRows_(ss, cutoffDate, checkedAt, sheets) {
  const archiveSheet = getSheetByNameCaseInsensitive_(ss, "Archive_Control");
  const headerMap = requireHeaderColumns_(archiveSheet, getInventorySchemaRequirements_().Archive_Control);
  const rowBySheetName = buildArchiveControlRowBySheetName_(archiveSheet, headerMap);
  const cutoffText = Utilities.formatDate(cutoffDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const checkedAtText = formatDateTimeForClient_(checkedAt);

  (sheets || []).forEach(function(sheetResult) {
    const sheetName = String(sheetResult && sheetResult.sheetName || "").trim();
    if (!sheetName) return;
    const rowObject = {
      sheet_name: sheetName,
      archive_before_date: cutoffText,
      last_checked_at: checkedAtText,
      eligible_rows: sheetResult.eligibleRows || 0,
      blocked_rows: sheetResult.blockedRows || 0,
      message: sheetResult.message || "فحص فقط: لم يتم نقل أو حذف أي بيانات."
    };
    const rowValues = buildRowByHeaders_(headerMap, rowObject);
    const existingRow = rowBySheetName[sheetName];
    if (existingRow) {
      const existingValues = archiveSheet.getRange(existingRow, 1, 1, headerMap.__lastColumn).getValues()[0];
      Object.keys(rowObject).forEach(function(headerName) {
        const column = getHeaderIndex_(headerMap, headerName);
        if (column > 0) existingValues[column - 1] = rowObject[headerName];
      });
      archiveSheet.getRange(existingRow, 1, 1, headerMap.__lastColumn).setValues([existingValues]);
    } else {
      archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, 1, headerMap.__lastColumn).setValues([rowValues]);
    }
  });
}

function getArchiveMetadataHeaders_() {
  return ["archived_at", "archived_by", "archive_run_id", "source_sheet", "source_row", "source_row_hash"];
}

function getArchiveSheetNameForSource_(sourceSheetName) {
  if (sourceSheetName === "Purchases") return "Purchases_Archive";
  if (sourceSheetName === "Transfers") return "Transfers_Archive";
  return "";
}

function normalizeArchiveHashValue_(value) {
  if (value instanceof Date) return formatDateTimeForClient_(value);
  if (value === null || value === undefined) return "";
  return String(value);
}

function computeArchiveSourceRowHash_(row) {
  const stableText = JSON.stringify((row || []).map(normalizeArchiveHashValue_));
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, stableText, Utilities.Charset.UTF_8);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    let value = bytes[i];
    if (value < 0) value += 256;
    const part = value.toString(16);
    hex += part.length === 1 ? "0" + part : part;
  }
  return hex;
}

function buildArchiveDedupKey_(sourceSheetName, sourceRow, sourceRowHash) {
  return [String(sourceSheetName || "").trim(), String(sourceRow || "").trim(), String(sourceRowHash || "").trim()].join("|");
}

function getEmptyArchiveCopySheetResult_(sheetName, archiveSheetName, blockedRows) {
  return {
    sheetName: sheetName,
    archiveSheetName: archiveSheetName || getArchiveSheetNameForSource_(sheetName),
    eligibleRows: 0,
    copiedRows: 0,
    skippedAlreadyArchivedRows: 0,
    blockedRows: blockedRows || 0,
    verificationPassed: true,
    message: ""
  };
}

function collectArchivePurchasesCandidatesR01Read_(ss, cutoffDate, dryRunBySheet) {
  const sheetName = "Purchases";
  const result = getEmptyArchiveCopySheetResult_(sheetName, getArchiveSheetNameForSource_(sheetName), dryRunBySheet.Purchases ? dryRunBySheet.Purchases.blockedRows : 0);
  const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
  if (!sheet) {
    result.verificationPassed = false;
    result.message = "جدول Purchases غير موجود.";
    return { result: result, candidates: [], sourceHeaders: [] };
  }
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Purchases);
  const totalRows = Math.max(0, sheet.getLastRow() - 1);
  const candidates = [];
  if (totalRows > 0) {
    const values = sheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
    for (let i = 0; i < values.length; i++) {
      const createdAt = parseSheetDate_(getCellByHeader_(values[i], headerMap, "created_at"));
      if (createdAt && createdAt < cutoffDate) {
        const sourceRow = i + 2;
        const hash = computeArchiveSourceRowHash_(values[i]);
        candidates.push({
          sourceSheetName: sheetName,
          sourceRow: sourceRow,
          sourceRowHash: hash,
          sourceValues: values[i]
        });
      }
    }
  }
  result.eligibleRows = candidates.length;
  return { result: result, candidates: candidates, sourceHeaders: headerMap.__headers || [] };
}

function collectArchiveTransfersCandidatesR01Read_(ss, cutoffDate, dryRunBySheet) {
  const sheetName = "Transfers";
  const result = getEmptyArchiveCopySheetResult_(sheetName, getArchiveSheetNameForSource_(sheetName), dryRunBySheet.Transfers ? dryRunBySheet.Transfers.blockedRows : 0);
  const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
  if (!sheet) {
    result.verificationPassed = false;
    result.message = "جدول Transfers غير موجود.";
    return { result: result, candidates: [], sourceHeaders: [] };
  }
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Transfers);
  const totalRows = Math.max(0, sheet.getLastRow() - 1);
  const candidates = [];
  if (totalRows > 0) {
    const values = sheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
      if (!createdAt || createdAt >= cutoffDate) continue;
      const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
      if (status !== "approved" && status !== "missing") continue;
      const sourceRow = i + 2;
      const hash = computeArchiveSourceRowHash_(row);
      candidates.push({
        sourceSheetName: sheetName,
        sourceRow: sourceRow,
        sourceRowHash: hash,
        sourceValues: row
      });
    }
  }
  result.eligibleRows = candidates.length;
  return { result: result, candidates: candidates, sourceHeaders: headerMap.__headers || [] };
}

function getOrCreateArchiveSheet_(ss, archiveSheetName, sourceHeaders) {
  let sheet = getSheetByNameCaseInsensitive_(ss, archiveSheetName);
  const requiredSourceHeaders = (sourceHeaders || []).filter(function(headerName) {
    return String(headerName || "").trim() !== "";
  });
  const requiredHeaders = requiredSourceHeaders.concat(getArchiveMetadataHeaders_());
  if (!sheet) {
    sheet = ss.insertSheet(archiveSheetName);
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return sheet;
  }

  const headerMap = getHeaderMap_(sheet);
  const missingHeaders = requiredHeaders.filter(function(headerName) {
    return !getHeaderIndex_(headerMap, headerName);
  });
  if (missingHeaders.length) {
    const startCol = Math.max(1, sheet.getLastColumn() + 1);
    sheet.getRange(1, startCol, 1, missingHeaders.length).setValues([missingHeaders]);
  }
  return sheet;
}

function getArchiveExistingKeyMap_(archiveSheet, headerMap) {
  const existing = {};
  const rowCount = Math.max(0, archiveSheet.getLastRow() - 1);
  if (rowCount < 1) return existing;
  const values = archiveSheet.getRange(2, 1, rowCount, headerMap.__lastColumn).getValues();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const sourceSheet = getCellByHeader_(row, headerMap, "source_sheet");
    const sourceRow = getCellByHeader_(row, headerMap, "source_row");
    const sourceHash = getCellByHeader_(row, headerMap, "source_row_hash");
    const key = buildArchiveDedupKey_(sourceSheet, sourceRow, sourceHash);
    if (key !== "||") existing[key] = true;
  }
  return existing;
}

function buildArchiveAppendRow_(archiveHeaderMap, sourceHeaderMap, candidate, metadata) {
  const row = new Array(archiveHeaderMap.__lastColumn || 0).fill("");
  (sourceHeaderMap.__headers || []).forEach(function(headerName, index) {
    if (!String(headerName || "").trim()) return;
    const column = getHeaderIndex_(archiveHeaderMap, headerName);
    if (column > 0) row[column - 1] = candidate.sourceValues[index];
  });
  Object.keys(metadata || {}).forEach(function(headerName) {
    const column = getHeaderIndex_(archiveHeaderMap, headerName);
    if (column > 0) row[column - 1] = metadata[headerName];
  });
  return row;
}

function appendArchiveCandidates_(ss, copyPlan, archiveRunId, archivedAt, archivedBy) {
  const result = copyPlan.result;
  if (!copyPlan.candidates.length) {
    result.message = "لا توجد صفوف مؤهلة للنسخ.";
    return result;
  }

  const archiveSheet = getOrCreateArchiveSheet_(ss, result.archiveSheetName, copyPlan.sourceHeaders);
  const requiredArchiveHeaders = (copyPlan.sourceHeaders || []).filter(function(headerName) {
    return String(headerName || "").trim() !== "";
  }).concat(getArchiveMetadataHeaders_());
  const archiveHeaderMap = requireHeaderColumns_(archiveSheet, requiredArchiveHeaders);
  const sourceHeaderMap = { __headers: copyPlan.sourceHeaders || [], __lastColumn: (copyPlan.sourceHeaders || []).length };
  (copyPlan.sourceHeaders || []).forEach(function(headerName, index) {
    sourceHeaderMap[normalizeHeaderName_(headerName)] = index + 1;
  });

  const existingKeys = getArchiveExistingKeyMap_(archiveSheet, archiveHeaderMap);
  const rowsToAppend = [];
  const copiedKeys = [];
  const archivedAtText = formatDateTimeForClient_(archivedAt);

  copyPlan.candidates.forEach(function(candidate) {
    const key = buildArchiveDedupKey_(candidate.sourceSheetName, candidate.sourceRow, candidate.sourceRowHash);
    if (existingKeys[key]) {
      result.skippedAlreadyArchivedRows++;
      return;
    }
    existingKeys[key] = true;
    copiedKeys.push(key);
    rowsToAppend.push(buildArchiveAppendRow_(archiveHeaderMap, sourceHeaderMap, candidate, {
      archived_at: archivedAtText,
      archived_by: archivedBy,
      archive_run_id: archiveRunId,
      source_sheet: candidate.sourceSheetName,
      source_row: candidate.sourceRow,
      source_row_hash: candidate.sourceRowHash
    }));
  });

  if (rowsToAppend.length) {
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, rowsToAppend.length, archiveHeaderMap.__lastColumn).setValues(rowsToAppend);
  }

  result.copiedRows = rowsToAppend.length;
  const afterKeys = getArchiveExistingKeyMap_(archiveSheet, archiveHeaderMap);
  result.verificationPassed = copiedKeys.every(function(key) { return afterKeys[key] === true; });
  result.message = result.verificationPassed
    ? "تم النسخ فقط، لم يتم حذف أي بيانات."
    : "تمت محاولة النسخ، لكن التحقق بعد النسخ لم ينجح بالكامل.";
  return result;
}

function updateArchiveControlCopyRows_(ss, cutoffDate, checkedAt, sheets) {
  const controlRows = (sheets || []).map(function(sheetResult) {
    return {
      sheetName: sheetResult.sheetName,
      eligibleRows: sheetResult.eligibleRows || 0,
      blockedRows: sheetResult.blockedRows || 0,
      message: "نسخ فقط: copied=" + (sheetResult.copiedRows || 0) +
        ", skipped_existing=" + (sheetResult.skippedAlreadyArchivedRows || 0) +
        ", verification=" + (sheetResult.verificationPassed ? "PASS" : "FAIL") +
        ". لم يتم حذف أي بيانات."
    };
  });
  updateArchiveControlDryRunRows_(ss, cutoffDate, checkedAt, controlRows);
}

function runArchiveCopy(sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    const user = requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();
    const checkedAt = new Date();
    const cutoffDate = getArchiveDryRunCutoffDate_();
    const cutoffText = Utilities.formatDate(cutoffDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const dryRunSheets = [
      scanArchiveDateOnlySheet_(ss, "Purchases", "created_at", cutoffDate, "جدول Purchases غير موجود.", false),
      scanArchiveTransfersSheet_(ss, cutoffDate)
    ];
    const dryRunBySheet = {};
    dryRunSheets.forEach(function(sheetResult) {
      dryRunBySheet[sheetResult.sheetName] = sheetResult;
    });
    const copyPlans = [
      collectArchivePurchasesCandidates_(ss, cutoffDate, dryRunBySheet),
      collectArchiveTransfersCandidates_(ss, cutoffDate, dryRunBySheet)
    ];
    const archiveRunId = "ARCHIVE_COPY_" + Utilities.formatDate(checkedAt, Session.getScriptTimeZone(), "yyyyMMddHHmmss") + "_" + checkedAt.getTime();
    const archivedBy = String(user && user.employeeNumber || user && user.name || "owner").trim();
    let sheets = [];

    withShortScriptLock_(15000, function() {
      assertSubmissionBalancesReady_(ss);
      sheets = copyPlans.map(function(plan) {
        return appendArchiveCandidates_(ss, plan, archiveRunId, checkedAt, archivedBy);
      });
      updateArchiveControlCopyRows_(ss, cutoffDate, checkedAt, sheets);
    });

    return {
      success: true,
      archiveRunId: archiveRunId,
      cutoffDate: cutoffText,
      checkedAt: formatDateTimeForClient_(checkedAt),
      sheets: sheets,
      message: "تم النسخ فقط، لم يتم حذف أي بيانات."
    };
  } catch (e) {
    console.error("runArchiveCopy failed", e);
    return {
      success: false,
      message: "تعذر نسخ الأرشيف حالياً. لم يتم حذف أي بيانات."
    };
  }
}

function runArchiveDryRun(sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();

    const checkedAt = new Date();
    const cutoffDate = getArchiveDryRunCutoffDate_();
    const cutoffText = Utilities.formatDate(cutoffDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    const sheets = [
      scanArchiveDateOnlySheet_(ss, "Purchases", "created_at", cutoffDate, "جدول Purchases غير موجود.", false),
      scanArchiveTransfersSheet_(ss, cutoffDate),
      scanArchiveDateOnlySheet_(ss, "Logs", "timestamp", cutoffDate, "جدول Logs غير موجود.", true)
    ];

    withShortScriptLock_(10000, function() {
      updateArchiveControlDryRunRows_(ss, cutoffDate, checkedAt, sheets);
    });

    return {
      success: true,
      checkedAt: formatDateTimeForClient_(checkedAt),
      cutoffDate: cutoffText,
      sheets: sheets,
      message: "تم فحص الأرشفة فقط. لم يتم نقل أو حذف أي بيانات."
    };
  } catch (e) {
    console.error("runArchiveDryRun failed", e);
    return {
      success: false,
      message: "تعذر فحص الأرشفة حالياً. لم يتم نقل أو حذف أي بيانات."
    };
  }
}

function getDefaultBalanceSnapshotMetadataByBranch_(branchIds, message) {
  const result = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (!id) return;
    result[id] = {
      latestBalanceCalculatedAt: "",
      latestBalanceRunId: "",
      latestBalanceStatus: "unavailable",
      latestBalanceMessage: message || "تعذر قراءة آخر تحديث رصيد حالياً."
    };
  });
  return result;
}

function getOwnerBranchSettings_(ss, branches) {
  const activeBranches = Array.isArray(branches) ? branches : [];
  const branchIds = activeBranches.map(function(branch) {
    return String(branch && branch.id || "").trim();
  }).filter(function(branchId) {
    return !!branchId;
  });
  const visibilityByBranch = getInventoryCountVisibilityMapForBranches_(ss, branchIds, getCurrentInventoryPeriod_());
  const visibilityDebugByBranch = getInventoryCountVisibilityDebugMapForBranches_(ss, branchIds, getCurrentInventoryPeriod_());
  let balanceByBranch;
  try {
    balanceByBranch = getLatestBalanceSnapshotMetadataByBranch_(ss, branchIds);
  } catch (e) {
    console.error("getOwnerBranchSettings_ balance metadata failed", {
      branchCount: branchIds.length,
      message: e && e.message ? String(e.message) : String(e || "")
    });
    balanceByBranch = getDefaultBalanceSnapshotMetadataByBranch_(branchIds, "تعذر قراءة آخر تحديث رصيد حالياً.");
  }

  return activeBranches.map(function(branch) {
    const branchId = String(branch && branch.id || "").trim();
    const balanceMeta = balanceByBranch[branchId] || {};
    const visibilityDebug = visibilityDebugByBranch[branchId] || {};
    return {
      branchId: branchId,
      branchName: String(branch && branch.name || "").trim(),
      inventoryCountVisible: visibilityByBranch[branchId] === true,
      inventoryControlRowNumberUsed: visibilityDebug.inventoryControlRowNumberUsed || "",
      inventoryControlVisibleRaw: getOwnerSettingsClientDebugValue_(visibilityDebug.inventoryControlVisibleRaw),
      inventoryControlStatusRaw: getOwnerSettingsClientDebugValue_(visibilityDebug.inventoryControlStatusRaw),
      inventoryControlPeriodRaw: getOwnerSettingsClientDebugValue_(visibilityDebug.inventoryControlPeriodRaw),
      inventoryControlFeatureKeyRaw: getOwnerSettingsClientDebugValue_(visibilityDebug.inventoryControlFeatureKeyRaw),
      inventoryControlEffectiveReason: visibilityDebug.inventoryControlEffectiveReason || "NO_CURRENT_PERIOD_ROW",
      latestBalanceCalculatedAt: balanceMeta.latestBalanceCalculatedAt || "",
      latestBalanceRunId: balanceMeta.latestBalanceRunId || "",
      latestBalanceStatus: balanceMeta.latestBalanceStatus || "",
      latestBalanceMessage: balanceMeta.latestBalanceMessage || ""
    };
  });
}

function getOwnerPurchasesR01Read_(branchId, dateFrom, dateTo, sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  requireOwner_(ss, sessionToken);
  ensureRuntimeSchemaReady_();

  const result = [];
  const targetBranch = String(branchId || "").trim();
  const branchMap = getBranchMap_(ss);
  const itemsMap = getReferenceItems_(ss).byId || {};
  const suppliersMap = getReferenceSuppliers_(ss).byId || {};
  const dateRange = resolveOwnerReportDateRange_({ dateFrom: dateFrom, dateTo: dateTo });

  // A summary carrying duplicate or malformed logical rows cannot be shown
  // as trusted totals, because no reader can tell which copy is authoritative.
  let summaryDegraded = false;
  if (dateRange.isDefaulted) {
    const summaryRows = getOwnerSummaryRows_(ss, dateRange, targetBranch, "purchase");
    summaryDegraded = Number(summaryRows.duplicateKeyCount || 0) > 0 ||
      Number(summaryRows.malformedRowCount || 0) > 0;
    if (summaryRows.usedSummary) {
      summaryRows.rows.forEach(function(row) {
        const itemId = String(getCellByHeader_(row, summaryRows.headerMap, "item_id") || "").trim();
        const bId = String(getCellByHeader_(row, summaryRows.headerMap, "branch_id") || "").trim();
        const item = itemsMap[itemId] || {};
        result.push({
          purchaseId: "SUMMARY",
          branchId: bId,
          branchName: branchMap.byId[bId] ? branchMap.byId[bId].name : bId,
          supplier: "ملخص يومي",
          itemId: itemId,
          itemName: item.nameAr || itemId,
          quantity: getCellByHeader_(row, summaryRows.headerMap, "quantity_in"),
          unit: item.baseUnit || "",
          normalizedQuantity: getCellByHeader_(row, summaryRows.headerMap, "quantity_in"),
          cost: getCellByHeader_(row, summaryRows.headerMap, "total_cost"),
          createdBy: "",
          createdAt: String(getCellByHeader_(row, summaryRows.headerMap, "summary_date") || "")
        });
      });
      return {
        success: true,
        purchases: result,
        usedSummary: true,
        usedRawRows: false,
        scanLimited: false,
        scannedRows: summaryRows.scannedRows,
        totalRows: summaryRows.totalRows
      };
    }
  }

  if (!isOwnerRawReportRangeAllowed_(dateRange)) {
    return {
      success: true,
      purchases: [],
      message: summaryDegraded ? getOwnerDegradedSummaryMessage_() : getOwnerWideRangeMessage_(),
      summaryDegraded: summaryDegraded,
      usedSummary: false,
      usedRawRows: false,
      scanLimited: true,
      scannedRows: 0,
      totalRows: 0
    };
  }

  const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
  if (!purchasesSheet) return { success: true, purchases: [], usedSummary: false, usedRawRows: false, scanLimited: false, scannedRows: 0, totalRows: 0 };
  const headerMap = requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases);
  const reportRows = getOwnerReportRows_(purchasesSheet, headerMap, dateRange, OWNER_PURCHASES_RECENT_SCAN_LIMIT);
  const data = reportRows.values;
  const dateFromStart = dateRange.dateFromStart;
  const dateToExclusive = dateRange.dateToExclusive;
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const bId = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
    if (targetBranch && bId !== targetBranch) continue;
    
    const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
    if (!createdAt) continue;
    if (createdAt < dateFromStart) continue;
    if (createdAt >= dateToExclusive) continue;
    
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    const supplierId = String(getCellByHeader_(row, headerMap, "supplier") || "").trim();
    
    result.push({
      purchaseId: getCellByHeader_(row, headerMap, "purchase_id"),
      branchId: bId,
      branchName: branchMap.byId[bId] ? branchMap.byId[bId].name : bId,
      supplier: suppliersMap[supplierId] ? suppliersMap[supplierId].nameAr : supplierId,
      itemId: itemId,
      itemName: itemsMap[itemId] ? itemsMap[itemId].nameAr : itemId,
      quantity: getCellByHeader_(row, headerMap, "quantity"),
      unit: getCellByHeader_(row, headerMap, "unit"),
      normalizedQuantity: getCellByHeader_(row, headerMap, "normalized_quantity"),
      cost: getCellByHeader_(row, headerMap, "cost"),
      createdBy: getCellByHeader_(row, headerMap, "created_by"),
      createdAt: formatDateTimeForClient_(createdAt)
    });
  }
  return {
    success: true,
    purchases: result,
    usedSummary: false,
    usedRawRows: true,
    scanLimited: reportRows.scanLimited,
    scanLimit: reportRows.scanLimit,
    scannedRows: reportRows.scannedRows,
    totalRows: reportRows.totalRows
  };
}

function getOwnerTransfersR01Read_(branchId, dateFrom, dateTo, sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  requireOwner_(ss, sessionToken);
  ensureRuntimeSchemaReady_();

  const result = [];
  const targetBranch = String(branchId || "").trim();
  const branchMap = getBranchMap_(ss);
  const itemsMap = getReferenceItems_(ss).byId || {};
  const dateRange = resolveOwnerReportDateRange_({ dateFrom: dateFrom, dateTo: dateTo });

  // A summary carrying duplicate or malformed logical rows cannot be shown
  // as trusted totals, because no reader can tell which copy is authoritative.
  let summaryDegraded = false;
  if (dateRange.isDefaulted) {
    const summaryRows = getOwnerSummaryRows_(ss, dateRange, targetBranch, "transfer");
    summaryDegraded = Number(summaryRows.duplicateKeyCount || 0) > 0 ||
      Number(summaryRows.malformedRowCount || 0) > 0;
    if (summaryRows.usedSummary) {
      summaryRows.rows.forEach(function(row) {
        const movementType = String(getCellByHeader_(row, summaryRows.headerMap, "movement_type") || "").trim();
        const itemId = String(getCellByHeader_(row, summaryRows.headerMap, "item_id") || "").trim();
        const bId = String(getCellByHeader_(row, summaryRows.headerMap, "branch_id") || "").trim();
        const item = itemsMap[itemId] || {};
        const isOutgoing = movementType === "outgoing_branch_transfer";
        const qty = isOutgoing ? getCellByHeader_(row, summaryRows.headerMap, "quantity_out") : getCellByHeader_(row, summaryRows.headerMap, "quantity_in");
        const pendingCount = Number(getCellByHeader_(row, summaryRows.headerMap, "pending_count") || 0);
        const missingCount = Number(getCellByHeader_(row, summaryRows.headerMap, "missing_count") || 0);
        result.push({
          transferId: "SUMMARY",
          sourceBranch: isOutgoing ? bId : "",
          sourceBranchName: isOutgoing ? (branchMap.byId[bId] ? branchMap.byId[bId].name : bId) : "تحويلات واردة",
          targetBranch: isOutgoing ? "" : bId,
          targetBranchName: isOutgoing ? "فروع أخرى" : (branchMap.byId[bId] ? branchMap.byId[bId].name : bId),
          itemId: itemId,
          itemName: item.nameAr || itemId,
          quantity: qty,
          unit: item.baseUnit || "",
          normalizedQuantity: qty,
          cost: getCellByHeader_(row, summaryRows.headerMap, "total_cost"),
          status: pendingCount > 0 ? "pending" : (missingCount > 0 ? "missing" : "approved"),
          missingQty: "",
          note: "ملخص يومي",
          createdBy: "",
          createdAt: String(getCellByHeader_(row, summaryRows.headerMap, "summary_date") || "")
        });
      });
      return {
        success: true,
        transfers: result,
        usedSummary: true,
        usedRawRows: false,
        scanLimited: false,
        scannedRows: summaryRows.scannedRows,
        totalRows: summaryRows.totalRows
      };
    }
  }

  if (!isOwnerRawReportRangeAllowed_(dateRange)) {
    return {
      success: true,
      transfers: [],
      message: summaryDegraded ? getOwnerDegradedSummaryMessage_() : getOwnerWideRangeMessage_(),
      summaryDegraded: summaryDegraded,
      usedSummary: false,
      usedRawRows: false,
      scanLimited: true,
      scannedRows: 0,
      totalRows: 0
    };
  }

  const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  if (!transfersSheet) return { success: true, transfers: [], usedSummary: false, usedRawRows: false, scanLimited: false, scannedRows: 0, totalRows: 0 };
  const headerMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);
  const reportRows = getOwnerReportRows_(transfersSheet, headerMap, dateRange, OWNER_TRANSFERS_RECENT_SCAN_LIMIT);
  const data = reportRows.values;
  const dateFromStart = dateRange.dateFromStart;
  const dateToExclusive = dateRange.dateToExclusive;
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const recBranch = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
    let srcBranch = String(getCellByHeader_(row, headerMap, "source_branch") || "").trim();
    if (!srcBranch) srcBranch = "DISTRIBUTOR";
    
    if (targetBranch && recBranch !== targetBranch && srcBranch !== targetBranch) continue;
    
    const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
    if (!createdAt) continue;
    if (createdAt < dateFromStart) continue;
    if (createdAt >= dateToExclusive) continue;
    
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    
    result.push({
      transferId: getCellByHeader_(row, headerMap, "transfer_id"),
      sourceBranch: srcBranch,
      sourceBranchName: srcBranch === "DISTRIBUTOR" ? "الموزع الرئيسي" : (branchMap.byId[srcBranch] ? branchMap.byId[srcBranch].name : srcBranch),
      targetBranch: recBranch,
      targetBranchName: branchMap.byId[recBranch] ? branchMap.byId[recBranch].name : recBranch,
      itemId: itemId,
      itemName: itemsMap[itemId] ? itemsMap[itemId].nameAr : itemId,
      quantity: getCellByHeader_(row, headerMap, "quantity"),
      unit: getCellByHeader_(row, headerMap, "unit"),
      normalizedQuantity: getCellByHeader_(row, headerMap, "normalized_quantity"),
      cost: getCellByHeader_(row, headerMap, "cost"),
      status: getCellByHeader_(row, headerMap, "status"),
      missingQty: getCellByHeader_(row, headerMap, "missing_qty"),
      note: getCellByHeader_(row, headerMap, "note"),
      createdBy: getCellByHeader_(row, headerMap, "created_by"),
      createdAt: formatDateTimeForClient_(createdAt)
    });
  }
  return {
    success: true,
    transfers: result,
    usedSummary: false,
    usedRawRows: true,
    scanLimited: reportRows.scanLimited,
    scanLimit: reportRows.scanLimit,
    scannedRows: reportRows.scannedRows,
    totalRows: reportRows.totalRows
  };
}

function parseVisibilityBoolean_(value) {
  if (value === true) return true;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "1" || text === "visible";
}

function normalizeInventoryFeatureKey_(featureKey) {
  return String(featureKey || "inventory_count").trim().toLowerCase() || "inventory_count";
}

function getSuccessfulBalanceRunForBranchPeriod_(runMap, runId, branchId, periodMonth) {
  if (!runMap || !runId || !branchId || !periodMonth) return null;
  return runMap.byRunBranchPeriod[getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth)] || null;
}

function getSuccessfulBalanceRunMap_(ss) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
  if (!sheet || sheet.getLastRow() < 2) return { hasRunLogRows: false, byRunBranchPeriod: {}, runsByIdForDiagnostics: {} };

  const headerMap = getHeaderMap_(sheet);
  if (!getHeaderIndex_(headerMap, "run_id") || !getHeaderIndex_(headerMap, "status")) {
    return { hasRunLogRows: false, byRunBranchPeriod: {}, runsByIdForDiagnostics: {} };
  }

  const data = sheet.getDataRange().getValues();
  return buildSuccessfulBalanceRunMapFromRows_(data.slice(1), headerMap, 2);
}

function getRecentSuccessfulBalanceRunMap_(ss, limit) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
  if (!sheet || sheet.getLastRow() < 2) return { hasRunLogRows: false, byRunBranchPeriod: {}, runsByIdForDiagnostics: {} };

  const headerMap = getHeaderMap_(sheet);
  const recentRows = getRecentSheetRows_(sheet, headerMap, limit || BALANCE_RUN_LOG_RECENT_SCAN_LIMIT);
  return buildSuccessfulBalanceRunMapFromRows_(recentRows.values, headerMap, recentRows.startRow);
}

function getActiveBalanceBranchIds_(ss) {
  const branches = getReferenceBranches_(ss).activeBranches || [];
  const branchIds = [];
  branches.forEach(function(branch) {
    const branchId = String(branch && branch.id ? branch.id : "").trim();
    if (branchId) branchIds.push(branchId);
  });
  return branchIds;
}

function getLatestSuccessfulBalanceRun_(ss, branchId, periodMonth) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
  if (!sheet || sheet.getLastRow() < 2) return null;

  const headerMap = getHeaderMap_(sheet);
  const required = ["run_id", "status", "period_month", "branch_id"];
  for (let i = 0; i < required.length; i++) {
    if (!getHeaderIndex_(headerMap, required[i])) return null;
  }

  const targetPeriod = String(periodMonth || "").trim();
  const targetBranchId = String(branchId || "").trim();
  if (!targetPeriod || !targetBranchId) return null;
  const data = sheet.getDataRange().getValues();
  let latest = null;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    if (status !== "success") continue;
    const rowPeriod = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    if (rowPeriod !== targetPeriod) continue;
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (rowBranchId !== targetBranchId) continue;

    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    if (!runId) continue;
    const finishedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "finished_at"));
    const startedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "started_at"));
    const sortTime = finishedAt ? finishedAt.getTime() : (startedAt ? startedAt.getTime() : 0);
    if (!latest || sortTime > latest.sortTime || (sortTime === latest.sortTime && i > latest.rowIndex)) {
      latest = {
        runId: runId,
        triggerType: String(getCellByHeader_(row, headerMap, "trigger_type") || "").trim(),
        periodStart: getCellByHeader_(row, headerMap, "period_start"),
        periodEnd: getCellByHeader_(row, headerMap, "period_end"),
        periodMonth: rowPeriod,
        status: status,
        branchesProcessed: getCellByHeader_(row, headerMap, "branches_processed"),
        itemsProcessed: getCellByHeader_(row, headerMap, "items_processed"),
        startedAt: startedAt,
        finishedAt: finishedAt,
        createdBy: String(getCellByHeader_(row, headerMap, "created_by") || "").trim(),
        message: String(getCellByHeader_(row, headerMap, "message") || "").trim(),
        branchId: rowBranchId,
        legacyGlobalFallback: false,
        sortTime: sortTime,
        rowIndex: i
      };
    }
  }

  if (!latest) return null;
  delete latest.sortTime;
  delete latest.rowIndex;
  return latest;
}

function verifyLogin(employeeNumber, pin) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const usersSheet = getSheetByNameCaseInsensitive_(ss, "Users");
    if (!usersSheet) {
      return { success: false, message: "جدول المستخدمين غير موجود." };
    }
    let logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    if (!logsSheet) {
      try {
        withShortScriptLock_(5000, function() {
          logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
          if (!logsSheet) {
            logsSheet = ss.insertSheet("Logs");
            logsSheet.getRange(1, 1, 1, 7).setValues([["log_id", "action", "user", "timestamp", "details", "entity_id", "entity_type"]]);
          }
        });
      } catch (lockError) {
        console.error("Lock error creating Logs sheet: " + lockError.toString());
        return { success: false, message: "السيرفر مشغول حالياً، يرجى المحاولة مرة أخرى لاحقاً" };
      }
    }
    const now = new Date();
    const submittedPin = normalizePin_(pin);
    if (!submittedPin) {
      try {
        withShortScriptLock_(5000, function() {
          logAction_("FAILED_LOGIN_INVALID_PIN_FORMAT", employeeNumber, logsSheet, now);
        });
      } catch (e) {
        console.error("Non-critical write lock timeout for FAILED_LOGIN_INVALID_PIN_FORMAT: " + e.toString());
      }
      return { success: false, message: "يجب أن يتكون الرمز السري من 4 أرقام دقيقة" };
    }
    
    // سحب بيانات المستخدمين والفروع في الذاكرة مرة واحدة فقط لكل تنفيذ.
    const usersIndex = getUsersIndex_(ss, usersSheet);
    const userFound = getUserByEmployeeNumberFromIndex_(usersIndex, employeeNumber);
    const userRowNumber = userFound ? userFound.rowNumber : -1;
    const statusColumn = usersIndex.statusColumn;
    
    // 1. التحقق من وجود المستخدم
    if (!userFound) {
      try {
        withShortScriptLock_(5000, function() {
          logAction_("FAILED_LOGIN_NO_USER", employeeNumber, logsSheet, now);
        });
      } catch (e) {
        console.error("Non-critical write lock timeout for FAILED_LOGIN_NO_USER: " + e.toString());
      }
      return { success: false, message: "رقم الموظف غير مسجل بالنظام" };
    }
    
    // 2. التحقق من حالة الحساب (نشط أم معطل)
    if (userFound.status === "blocked") {
      return { success: false, message: "تم تجميد هذا الحساب بسبب محاولات دخول خاطئة متكررة. راجع الإدارة لإعادة التفعيل." };
    }
    if (userFound.status !== "active") {
      try {
        withShortScriptLock_(5000, function() {
          logAction_("FAILED_LOGIN_INACTIVE", employeeNumber, logsSheet, now);
        });
      } catch (e) {
        console.error("Non-critical write lock timeout for FAILED_LOGIN_INACTIVE: " + e.toString());
      }
      return { success: false, message: "هذا الحساب معطل حالياً، راجع الإدارة" };
    }
    
    // 3. القفل الأمني المؤقت (5 دقائق) عند 5 محاولات خاطئة
    const lockInfo = getTemporaryLockInfo_(employeeNumber, logsSheet, now);
    if (lockInfo.locked) {
      try {
        withShortScriptLock_(5000, function() {
          const lockInfoUnderLock = getTemporaryLockInfo_(employeeNumber, logsSheet, now);
          if (lockInfoUnderLock.locked) {
            if (userRowNumber > 1 && statusColumn > 0) {
              usersSheet.getRange(userRowNumber, statusColumn, 1, 1).setValues([["blocked"]]);
            }
          }
        });
        SpreadsheetApp.flush();
      } catch (lockError) {
        console.error("Critical status write lock timeout for temporary lock status check: " + lockError.toString());
        return { success: false, message: "السيرفر مشغول حالياً، يرجى المحاولة مرة أخرى لاحقاً" };
      }
      return {
        success: false,
        message: "تم تجميد هذا الحساب بسبب محاولات دخول خاطئة متكررة. راجع الإدارة لإعادة التفعيل."
      };
    }
    
    // 4. مطابقة الرمز السري (PIN)
    if (verifyPinForUser_(submittedPin, userFound)) {
      // Migrate legacy user if needed
      const hasHash = userFound.pinHash && String(userFound.pinHash).trim() !== "";
      const hasSalt = userFound.pinSalt && String(userFound.pinSalt).trim() !== "";
      if (!hasHash || !hasSalt) {
        try {
          migrateLegacyPinToHashIfNeeded_(ss, usersSheet, usersIndex, userFound, submittedPin);
        } catch (migrationError) {
          console.error("PIN legacy migration failed: " + migrationError.toString());
        }
      }
      try {
        withShortScriptLock_(5000, function() {
          logAction_("SUCCESSFUL_LOGIN", employeeNumber, logsSheet, now);
        });
      } catch (e) {
        console.error("Non-critical write lock timeout for SUCCESSFUL_LOGIN: " + e.toString());
      }
      clearLoginFailureAttempts_(employeeNumber);
      const sessionToken = createSessionToken_(userFound.employeeNumber);
      // إرجاع بيانات المستخدم لبناء الجلسة في المتصفح (بدون كلمة السر)
      return {
        success: true,
        sessionToken: sessionToken,
        user: {
          employeeNumber: userFound.employeeNumber,
          name: userFound.name,
          role: userFound.role,
          branch: userFound.branch,
          branchId: userFound.branchId
        }
      };
    } else {
      let isBlockedNow = false;
      try {
        withShortScriptLock_(5000, function() {
          logAction_("FAILED_LOGIN_WRONG_PIN", employeeNumber, logsSheet, now);
          recordLoginFailureAttempt_(employeeNumber, now);
          if (shouldPermanentlyBlockUser_(employeeNumber, logsSheet, now)) {
            if (userRowNumber > 1 && statusColumn > 0) {
              usersSheet.getRange(userRowNumber, statusColumn, 1, 1).setValues([["blocked"]]);
            }
            isBlockedNow = true;
          }
        });
        SpreadsheetApp.flush();
      } catch (lockError) {
        console.error("Critical status write lock timeout for wrong PIN: " + lockError.toString());
        return { success: false, message: "السيرفر مشغول حالياً، يرجى المحاولة مرة أخرى لاحقاً" };
      }
      
      if (isBlockedNow) {
        return { success: false, message: "تم تجميد هذا الحساب بسبب محاولات دخول خاطئة متكررة. راجع الإدارة لإعادة التفعيل." };
      }
      return { success: false, message: "الرمز السري (PIN) غير صحيح" };
    }
    
  } catch (e) {
    console.error("Exception in verifyLogin: " + e.toString());
    return { success: false, message: "السيرفر مشغول حالياً، يرجى المحاولة مرة أخرى لاحقاً" };
  }
}

function generatePinSalt_() {
  return Utilities.getUuid() + "_" + new Date().getTime();
}

function hashPin_(pin, salt) {
  const normalizedPin = normalizePin_(pin);
  const signatureBytes = Utilities.computeHmacSha256Signature(normalizedPin, salt);
  let hexString = "";
  for (let i = 0; i < signatureBytes.length; i++) {
    let byteVal = signatureBytes[i];
    if (byteVal < 0) {
      byteVal += 256;
    }
    let byteHex = byteVal.toString(16);
    if (byteHex.length === 1) {
      byteHex = "0" + byteHex;
    }
    hexString += byteHex;
  }
  return hexString;
}

function verifyPinForUser_(submittedPin, userRecord) {
  if (!userRecord) return false;
  const normalizedSubmitted = normalizePin_(submittedPin);
  if (!normalizedSubmitted) return false;
  
  const hasHash = userRecord.pinHash && String(userRecord.pinHash).trim() !== "";
  const hasSalt = userRecord.pinSalt && String(userRecord.pinSalt).trim() !== "";
  
  if (hasHash && hasSalt) {
    const computedHash = hashPin_(normalizedSubmitted, userRecord.pinSalt);
    return computedHash === userRecord.pinHash;
  }
  
  const legacyPin = normalizePin_(userRecord.pin);
  return legacyPin === normalizedSubmitted;
}

function ensureUsersColumnsExist_(usersSheet) {
  const headers = usersSheet.getRange(1, 1, 1, Math.max(1, usersSheet.getLastColumn())).getValues()[0] || [];
  const required = ["pin_hash", "pin_salt", "pin_migrated_at"];
  const missing = [];
  required.forEach(function(col) {
    if (findHeaderColumn_(headers, [col], 0) === 0) {
      missing.push(col);
    }
  });
  if (missing.length > 0) {
    withShortScriptLock_(5000, function() {
      const curHeaders = usersSheet.getRange(1, 1, 1, Math.max(1, usersSheet.getLastColumn())).getValues()[0] || [];
      const curMissing = [];
      required.forEach(function(col) {
        if (findHeaderColumn_(curHeaders, [col], 0) === 0) {
          curMissing.push(col);
        }
      });
      if (curMissing.length > 0) {
        const startCol = usersSheet.getLastColumn() + 1;
        usersSheet.getRange(1, startCol, 1, curMissing.length).setValues([curMissing]);
      }
    });
    SpreadsheetApp.flush();
  }
}

function migrateLegacyPinToHashIfNeeded_(ss, usersSheet, usersIndex, userRecord, submittedPin) {
  ensureUsersColumnsExist_(usersSheet);
  
  const headers = usersSheet.getRange(1, 1, 1, usersSheet.getLastColumn()).getValues()[0] || [];
  const pinHashCol = findHeaderColumn_(headers, ["pin_hash"], 0);
  const pinSaltCol = findHeaderColumn_(headers, ["pin_salt"], 0);
  const pinMigratedAtCol = findHeaderColumn_(headers, ["pin_migrated_at"], 0);
  
  if (!pinHashCol || !pinSaltCol || !pinMigratedAtCol) {
    console.error("Migration failed: columns not found in Users sheet even after ensuring their existence.");
    return;
  }
  
  const salt = generatePinSalt_();
  const hash = hashPin_(submittedPin, salt);
  const nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  const rowNumber = userRecord.rowNumber;
  
  withShortScriptLock_(5000, function() {
    usersSheet.getRange(rowNumber, pinHashCol).setValue(hash);
    usersSheet.getRange(rowNumber, pinSaltCol).setValue(salt);
    usersSheet.getRange(rowNumber, pinMigratedAtCol).setValue(nowStr);
  });
  SpreadsheetApp.flush();
}

function requireOwnerForAdmin_(sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const owner = requireOwner_(ss, sessionToken);
  return { ss: ss, owner: owner };
}

function createMutationToken_(userEmployeeNumber, action, ttlSeconds) {
  const employeeNumber = normalizeEmployeeNumber_(userEmployeeNumber);
  const actionName = String(action || "").trim();
  if (!employeeNumber || !actionName) {
    throw new Error("تعذر إنشاء رمز حماية العملية.");
  }
  const token = Utilities.getUuid() + "-" + new Date().getTime();
  CacheService.getScriptCache().put(
    "mutation_" + token,
    JSON.stringify({
      employeeNumber: employeeNumber,
      action: actionName,
      issuedAt: new Date().toISOString()
    }),
    Math.max(60, parseInt(ttlSeconds, 10) || 600)
  );
  return token;
}

function consumeMutationToken_(token, userEmployeeNumber, action) {
  const tokenValue = String(token || "").trim();
  const employeeNumber = normalizeEmployeeNumber_(userEmployeeNumber);
  const actionName = String(action || "").trim();
  const duplicateMessage = "تم إرسال العملية مسبقاً أو انتهت صلاحيتها. الرجاء تحديث الشاشة والمحاولة من جديد.";
  if (!tokenValue) {
    throw new Error(duplicateMessage);
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "mutation_" + tokenValue;
  const cached = cache.get(cacheKey);
  if (!cached) {
    throw new Error(duplicateMessage);
  }

  cache.remove(cacheKey);
  let tokenData;
  try {
    tokenData = JSON.parse(cached);
  } catch (e) {
    throw new Error(duplicateMessage);
  }

  if (
    normalizeEmployeeNumber_(tokenData.employeeNumber) !== employeeNumber ||
    String(tokenData.action || "").trim() !== actionName
  ) {
    throw new Error(duplicateMessage);
  }
  return true;
}

function createSessionToken_(employeeNumber) {
  const token = Utilities.getUuid() + "-" + new Date().getTime();
  CacheService.getScriptCache().put(
    "session_" + token,
    JSON.stringify({
      employeeNumber: normalizeEmployeeNumber_(employeeNumber),
      issuedAt: new Date().toISOString()
    }),
    21600
  );
  return token;
}

function getAuthorizedUser_(ss, sessionToken, allowedRoles) {
  const token = String(sessionToken || "").trim();
  if (!token) {
    throw new Error("انتهت الجلسة أو أنها غير صالحة. الرجاء تسجيل الدخول مجدداً.");
  }

  const cached = CacheService.getScriptCache().get("session_" + token);
  if (!cached) {
    throw new Error("انتهت الجلسة أو أنها غير صالحة. الرجاء تسجيل الدخول مجدداً.");
  }

  let session;
  try {
    session = JSON.parse(cached);
  } catch (e) {
    throw new Error("بيانات الجلسة غير صالحة. الرجاء تسجيل الدخول مجدداً.");
  }

  const user = getUserByEmployeeNumber_(ss, session.employeeNumber);
  if (!user) {
    throw new Error("رقم الموظف غير مسجل بالنظام.");
  }
  if (user.status !== "active") {
    throw new Error("تم تجميد هذا الحساب أو تعطيله. راجع الإدارة.");
  }

  const roles = Array.isArray(allowedRoles) ? allowedRoles.map(normalizeRole_) : [];
  if (roles.length && roles.indexOf(user.role) === -1) {
    throw new Error("ليست لديك صلاحية لتنفيذ هذه العملية.");
  }

  return user;
}

function requireOwner_(ss, sessionToken) {
  return getAuthorizedUser_(ss, sessionToken, ["owner"]);
}

function requireActiveBranch_(ss, branchId) {
  const targetBranchId = String(branchId || "").trim();
  if (!targetBranchId) {
    throw new Error("الرجاء تحديد فرع صالح.");
  }
  const branch = getBranchMap_(ss).byId[targetBranchId];
  if (!branch || !branch.active) {
    throw new Error("الفرع المستهدف غير نشط أو غير موجود.");
  }
  return branch;
}

function getLoginThrottleCacheKey_(employeeNumber) {
  return "login_fail_v1_" + String(employeeNumber || "").trim();
}

function readRecentLoginFailureTimes_(employeeNumber, now) {
  try {
    const raw = CacheService.getScriptCache().get(getLoginThrottleCacheKey_(employeeNumber));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const fiveMinutesInMs = 5 * 60 * 1000;
    const nowMs = now.getTime();
    return parsed
      .map(function(value) { return Number(value); })
      .filter(function(ms) { return isFinite(ms) && ms <= nowMs && (nowMs - ms) <= fiveMinutesInMs; });
  } catch (e) {
    console.error("readRecentLoginFailureTimes_ failed: " + e.toString());
    return [];
  }
}

function recordLoginFailureAttempt_(employeeNumber, now) {
  try {
    const failureTimes = readRecentLoginFailureTimes_(employeeNumber, now);
    failureTimes.push(now.getTime());
    CacheService.getScriptCache().put(
      getLoginThrottleCacheKey_(employeeNumber),
      JSON.stringify(failureTimes.slice(-10)),
      300
    );
  } catch (e) {
    console.error("recordLoginFailureAttempt_ failed: " + e.toString());
  }
}

function clearLoginFailureAttempts_(employeeNumber) {
  try {
    CacheService.getScriptCache().remove(getLoginThrottleCacheKey_(employeeNumber));
  } catch (e) {
    console.error("clearLoginFailureAttempts_ failed: " + e.toString());
  }
}

function shouldPermanentlyBlockUser_(employeeNumber, logsSheet, now) {
  const lockInfo = getTemporaryLockInfo_(employeeNumber, logsSheet, now);
  if (lockInfo.locked) return true;

  // Legacy log-scan fallback: cache eviction must not disable throttling entirely.
  const logsData = getRecentLogRows_(logsSheet, 500);
  const fiveMinutesInMs = 5 * 60 * 1000;
  let failCount = 0;

  for (let i = logsData.length - 1; i >= 0; i--) {
    const logTime = new Date(logsData[i][3]);
    if (isNaN(logTime.getTime())) continue;
    if ((now - logTime) > fiveMinutesInMs) break;

    if (String(logsData[i][2]) !== String(employeeNumber)) continue;
    const action = String(logsData[i][1] || "");

    if (action === "FAILED_LOGIN_WRONG_PIN") {
      failCount++;
      if (failCount >= 5) return true;
    } else if (action === "SUCCESSFUL_LOGIN") {
      break;
    }
  }
  return false;
}

function getTemporaryLockInfo_(employeeNumber, logsSheet, now) {
  const fiveMinutesInMs = 5 * 60 * 1000;
  const cachedFailureTimes = readRecentLoginFailureTimes_(employeeNumber, now);
  if (cachedFailureTimes.length >= 5) {
    const newestCachedMs = Math.max.apply(null, cachedFailureTimes);
    const cachedRemainingMs = fiveMinutesInMs - (now.getTime() - newestCachedMs);
    if (cachedRemainingMs > 0) {
      return {
        locked: true,
        remainingMinutes: Math.max(1, Math.ceil(cachedRemainingMs / 60000))
      };
    }
  }

  // Legacy log-scan fallback: cache eviction must not disable throttling entirely.
  const logsData = getRecentLogRows_(logsSheet, 500);
  let failCount = 0;
  let newestFailureTime = null;
  
  for (let i = logsData.length - 1; i >= 0; i--) {
    const logTime = new Date(logsData[i][3]);
    if (isNaN(logTime.getTime())) continue;
    const timeDiff = now - logTime;
    if (timeDiff > fiveMinutesInMs) break;
    
    if (String(logsData[i][2] || "").trim() === String(employeeNumber || "").trim()) {
      if (logsData[i][1] === "FAILED_LOGIN_WRONG_PIN") {
        if (!newestFailureTime) newestFailureTime = logTime;
        failCount++;
      } else if (logsData[i][1] === "SUCCESSFUL_LOGIN") {
        break;
      }
    }
  }

  if (failCount >= 5 && newestFailureTime) {
    const elapsedMs = now - newestFailureTime;
    const remainingMs = fiveMinutesInMs - elapsedMs;
    if (remainingMs > 0) {
      return {
        locked: true,
        remainingMinutes: Math.max(1, Math.ceil(remainingMs / 60000))
      };
    }
  }
  return { locked: false, remainingMinutes: 0 };
}

function logoutUserSession(sessionToken) {
  try {
    const token = String(sessionToken || "").trim();
    if (token) {
      CacheService.getScriptCache().remove("session_" + token);
    }
    return { success: true };
  } catch (e) {
    // Never expose the token; logout must stay best-effort for the client.
    console.error("logoutUserSession cache removal failed: " + (e && e.message ? e.message : String(e)));
    return { success: true };
  }
}

function getSheetHeaders_(sheet) {
  if (!sheet || sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] || [];
}

function getHeaderMap_(sheet) {
  const headers = getSheetHeaders_(sheet);
  const map = {
    __sheetName: sheet ? sheet.getName() : "",
    __headers: headers,
    __lastColumn: headers.length
  };
  for (let i = 0; i < headers.length; i++) {
    const headerName = normalizeHeaderName_(headers[i]);
    if (headerName && !map[headerName]) {
      map[headerName] = i + 1;
    }
  }
  return map;
}

function getHeaderIndex_(headerMap, headerName) {
  return headerMap ? (headerMap[normalizeHeaderName_(headerName)] || 0) : 0;
}

function getInventorySchemaAliases_() {
  return {
    branches: {
      name_ar: ["name", "branch_name", "branch_name_ar", "اسم الفرع"]
    },
    Suppliers: {
      name_ar: ["supplier_name_ar", "name", "supplier_name", "اسم المورد"]
    }
  };
}

function getHeaderIndexWithAliases_(headerMap, sheetName, headerName) {
  const canonicalHeader = normalizeHeaderName_(headerName);
  const directColumn = getHeaderIndex_(headerMap, canonicalHeader);
  if (directColumn) return directColumn;

  const sheetAliases = getInventorySchemaAliases_()[sheetName] || {};
  const aliases = sheetAliases[canonicalHeader] || [];
  for (let i = 0; i < aliases.length; i++) {
    const aliasColumn = getHeaderIndex_(headerMap, aliases[i]);
    if (aliasColumn) return aliasColumn;
  }
  return 0;
}

function requireHeaderColumns_(sheet, requiredHeaders) {
  const headerMap = getHeaderMap_(sheet);
  const missing = [];
  const sheetName = sheet.getName();
  (requiredHeaders || []).forEach(function(headerName) {
    const column = getHeaderIndexWithAliases_(headerMap, sheetName, headerName);
    if (column) {
      headerMap[normalizeHeaderName_(headerName)] = column;
    } else {
      missing.push(headerName);
    }
  });
  if (missing.length) {
    throw new Error("الأعمدة المطلوبة مفقودة في جدول " + sheet.getName() + ": " + missing.join(", "));
  }
  return headerMap;
}

function getSchemaAliasWarnings_(sheetName, headerMap, requiredHeaders) {
  const warnings = [];
  const sheetAliases = getInventorySchemaAliases_()[sheetName] || {};
  (requiredHeaders || []).forEach(function(headerName) {
    const canonicalHeader = normalizeHeaderName_(headerName);
    if (getHeaderIndex_(headerMap, canonicalHeader)) return;
    const aliases = sheetAliases[canonicalHeader] || [];
    for (let i = 0; i < aliases.length; i++) {
      if (getHeaderIndex_(headerMap, aliases[i])) {
        warnings.push("جدول " + sheetName + " يستخدم العنوان البديل " + aliases[i] + " بدلاً من " + headerName + ".");
        return;
      }
    }
  });
  return warnings;
}

function getMissingRequiredHeaders_(sheet, requiredHeaders) {
  const headerMap = getHeaderMap_(sheet);
  const sheetName = sheet.getName();
  return (requiredHeaders || []).filter(function(headerName) {
    return !getHeaderIndexWithAliases_(headerMap, sheetName, headerName);
  });
}

function buildRowByHeaders_(headerMap, rowObject) {
  const row = new Array(headerMap.__lastColumn || 0).fill("");
  Object.keys(rowObject || {}).forEach(function(headerName) {
    const column = getHeaderIndex_(headerMap, headerName);
    if (column > 0) row[column - 1] = rowObject[headerName];
  });
  return row;
}

function getCellByHeader_(row, headerMap, headerName) {
  const column = getHeaderIndex_(headerMap, headerName);
  return column > 0 ? row[column - 1] : "";
}

function getProjectedSheetRowsByHeaders_(sheet, headerMap, headerNames) {
  if (!sheet || !headerMap || sheet.getLastRow() < 2) {
    return [headerMap && headerMap.__headers ? headerMap.__headers : []];
  }

  const lastRow = sheet.getLastRow();
  const rowCount = lastRow - 1;
  const width = headerMap.__lastColumn || sheet.getLastColumn();
  const rows = [headerMap.__headers || []];
  const columns = [];
  const seenColumns = {};

  (headerNames || []).forEach(function(headerName) {
    const column = getHeaderIndex_(headerMap, headerName);
    if (column > 0 && !seenColumns[column]) {
      seenColumns[column] = true;
      columns.push({ column: column, values: sheet.getRange(2, column, rowCount, 1).getValues() });
    }
  });

  for (let r = 0; r < rowCount; r++) {
    const row = new Array(width).fill("");
    columns.forEach(function(col) {
      row[col.column - 1] = col.values[r][0];
    });
    rows.push(row);
  }
  return rows;
}

function uniqueSortedRowNumbers_(rowNumbers) {
  const seen = {};
  (rowNumbers || []).forEach(function(rowNumber) {
    const n = Number(rowNumber || 0);
    if (n >= 2) seen[n] = true;
  });
  return Object.keys(seen).map(function(key) {
    return Number(key);
  }).sort(function(a, b) {
    return a - b;
  });
}

function groupContiguousRowNumbers_(rowNumbers) {
  const sorted = uniqueSortedRowNumbers_(rowNumbers);
  const groups = [];
  sorted.forEach(function(rowNumber) {
    const last = groups.length ? groups[groups.length - 1] : null;
    if (last && rowNumber === last.end + 1) {
      last.end = rowNumber;
    } else {
      groups.push({ start: rowNumber, end: rowNumber });
    }
  });
  return groups;
}

function getProjectedSheetRowsByRowNumbersAndHeaders_(sheet, headerMap, headerNames, rowNumbers) {
  const rows = [headerMap && headerMap.__headers ? headerMap.__headers : []];
  if (!sheet || !headerMap || sheet.getLastRow() < 2) return rows;

  const groups = groupContiguousRowNumbers_(rowNumbers).filter(function(group) {
    return group.start <= sheet.getLastRow();
  });
  if (!groups.length) return rows;

  const width = headerMap.__lastColumn || sheet.getLastColumn();
  const columns = [];
  const seenColumns = {};
  (headerNames || []).forEach(function(headerName) {
    const column = getHeaderIndex_(headerMap, headerName);
    if (column > 0 && !seenColumns[column]) {
      seenColumns[column] = true;
      columns.push(column);
    }
  });

  groups.forEach(function(group) {
    const rowCount = group.end - group.start + 1;
    const projectedRows = [];
    for (let r = 0; r < rowCount; r++) {
      projectedRows.push(new Array(width).fill(""));
    }
    columns.forEach(function(column) {
      const values = sheet.getRange(group.start, column, rowCount, 1).getValues();
      for (let r = 0; r < rowCount; r++) {
        projectedRows[r][column - 1] = values[r][0];
      }
    });
    rows.push.apply(rows, projectedRows);
  });
  return rows;
}

function getInventorySchemaRequirements_() {
  return {
    Users: ["employee_number", "pin", "name", "role", "branch", "status", "pin_hash", "pin_salt", "pin_migrated_at"],
    branches: ["branch_id", "name_ar", "status"],
    Items: ["item_id", "name_ar", "base_unit"],
    Item_Units: ["item_id", "unit_name", "conversion_rate"],
    Suppliers: ["supplier_id", "name_ar", "status"],
    Supplier_Items: ["supplier_id", "item_id", "status"],
    Allowed_Local_Purchases: ["branch_id", "item_id"],
    Transfers: ["transfer_id", "branch", "source_branch", "item_id", "quantity", "unit", "normalized_quantity", "cost", "status", "missing_qty", "note", "received_quantity", "received_unit", "received_normalized_quantity", "received_at", "received_by", "created_by", "created_at"],
    Purchases: ["purchase_id", "branch", "supplier", "item_id", "quantity", "unit", "normalized_quantity", "cost", "created_by", "created_at"],
    Feature_Visibility: ["branch_id", "feature_key", "visible", "updated_by", "updated_at"],
    Inventory_Control: ["branch_id", "inventory_period", "feature_key", "visible", "status", "opened_by", "opened_at", "closed_by", "closed_at", "submitted_by", "submitted_at", "note"],
    Inventory_Counts: ["count_id", "branch_id", "inventory_period", "period_month", "status", "submitted_by", "submitted_at", "locked_by", "locked_at", "note", "created_by", "created_at", "updated_at", "item_id", "counted_quantity", "unit", "normalized_quantity"],
    Inventory_Count_Lines: ["count_id", "branch_id", "inventory_period", "period_month", "item_id", "count_quantity", "counted_quantity", "unit", "normalized_quantity", "created_at"],
    Inventory_Balances: ["snapshot_id", "branch_id", "item_id", "period_month", "period_start", "period_end", "starting_balance", "total_in", "total_out", "balance", "calculated_at", "calculated_by", "run_id"],
    Inventory_Balance_Run_Log: ["run_id", "trigger_type", "period_start", "period_end", "period_month", "branch_id", "status", "branches_processed", "items_processed", "started_at", "finished_at", "created_by", "message"],
    Inventory_Balance_Current: ["branch_id", "item_id", "period_month", "period_start", "period_end", "starting_balance", "total_in", "total_out", "balance", "calculated_at", "calculated_by", "run_id", "updated_at"],
    Movement_Daily_Summary: ["summary_date", "period_month", "branch_id", "item_id", "source_type", "movement_type", "quantity_in", "quantity_out", "net_quantity", "purchase_count", "transfer_count", "pending_count", "approved_count", "missing_count", "zero_receipt_count", "total_cost", "last_source_row", "last_source_updated_at", "updated_at"],
    Pending_Transfer_Index: ["transfer_row", "transfer_id", "branch_id", "source_branch", "item_id", "quantity", "unit", "normalized_quantity", "created_by", "created_at", "status", "receipt_state", "updated_at"],
    Archive_Control: ["sheet_name", "archive_before_date", "last_checked_at", "eligible_rows", "blocked_rows", "message"]
  };
}

function getReferenceCacheKeys_() {
  return [
    "ref_items_v1",
    "ref_item_units_v1",
    "ref_branches_v1",
    "ref_suppliers_v1",
    "ref_supplier_items_v1",
    "ref_allowed_local_purchases_v1"
  ];
}

function isReferenceCacheSheet_(sheetName) {
  const normalizedName = String(sheetName || "").trim().toLowerCase();
  const referenceSheets = {
    "items": true,
    "item_units": true,
    "branches": true,
    "suppliers": true,
    "supplier_items": true,
    "allowed_local_purchases": true,
    "feature_visibility": true
  };
  return !!referenceSheets[normalizedName];
}

function clearReferenceCache_() {
  try {
    CacheService.getScriptCache().removeAll(getReferenceCacheKeys_());
    return { success: true, message: "تم مسح ذاكرة البيانات المرجعية المؤقتة بنجاح." };
  } catch (e) {
    console.error("clearReferenceCache_ failed", e);
    return { success: false, message: "تعذر مسح ذاكرة البيانات المرجعية المؤقتة حالياً." };
  }
}

function clearReferenceCache(sessionToken) {
  try {
    requireOwnerForAdmin_(sessionToken);
    return clearReferenceCache_();
  } catch (e) {
    console.error("clearReferenceCache failed", e);
    return { success: false, message: "تعذر مسح ذاكرة البيانات المرجعية المؤقتة حالياً." };
  }
}

function adminClearReferenceCache(sessionToken) {
  return clearReferenceCache(sessionToken);
}

function invalidateReferenceCacheForEditedSheet_(sheetName, editedBy) {
  const editedSheetName = String(sheetName || "").trim();
  if (!isReferenceCacheSheet_(editedSheetName)) {
    return { success: true, invalidated: false, sheetName: editedSheetName, message: "لا يحتاج هذا الجدول إلى مسح ذاكرة البيانات المرجعية." };
  }

  const clearResult = clearReferenceCache_();
  if (clearResult && clearResult.success) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
      if (logsSheet) {
        logActionDetail_("REFERENCE_CACHE_INVALIDATED", editedBy || "onEdit", {
          entityType: "reference_cache",
          entityId: editedSheetName,
          sheetName: editedSheetName
        }, logsSheet, new Date());
      }
    } catch (logError) {
      // Cache invalidation should not fail just because audit logging failed.
    }
  }
  return {
    success: !!(clearResult && clearResult.success),
    invalidated: !!(clearResult && clearResult.success),
    sheetName: editedSheetName,
    message: clearResult && clearResult.message ? clearResult.message : "تعذر مسح ذاكرة البيانات المرجعية المؤقتة."
  };
}

function onEdit(e) {
  try {
    const eventRange = e && e.range;
    const editedSheet = eventRange && typeof eventRange.getSheet === "function" ? eventRange.getSheet() : null;
    if (!editedSheet || typeof editedSheet.getName !== "function") return;

    let editedBy = "onEdit";
    try {
      const activeUser = Session.getActiveUser();
      const userEmail = activeUser && typeof activeUser.getEmail === "function" ? activeUser.getEmail() : "";
      if (userEmail) editedBy = userEmail;
    } catch (userError) {
      // Simple triggers may not expose the active user.
    }

    invalidateReferenceCacheForEditedSheet_(editedSheet.getName(), editedBy);
  } catch (ignored) {
    // Simple triggers must never surface operational cache errors to sheet editors.
  }
}

function logReferenceCacheParseFailure_(cacheKey, parseError) {
  try {
    const cache = CacheService.getScriptCache();
    const rateLimitKey = "cache_parse_warned_" + String(cacheKey || "").trim();
    if (cache.get(rateLimitKey)) return;
    cache.put(rateLimitKey, "1", 300);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    if (!logsSheet) return;

    const errorText = parseError && parseError.message ? parseError.message : String(parseError || "");
    logActionDetail_("REFERENCE_CACHE_PARSE_FAILED", "SYSTEM", {
      entityType: "reference_cache",
      entityId: cacheKey,
      cacheKey: cacheKey,
      error: errorText.slice(0, 200)
    }, logsSheet, new Date());
  } catch (logError) {
    // Bad cache entries should still be rebuilt even if warning logging fails.
  }
}

function rebuildReferenceData_(ss) {
  return {
    items: getReferenceItems_(ss),
    itemUnits: getReferenceItemUnits_(ss),
    branches: getReferenceBranches_(ss),
    suppliers: getReferenceSuppliers_(ss),
    supplierItems: getReferenceSupplierItems_(ss),
    allowedLocalPurchases: getReferenceAllowedLocalPurchases_(ss)
  };
}

function validateReferenceDataShape_(referenceData) {
  const issues = [];
  const data = referenceData || {};
  const checks = [
    { key: "items", collection: "byId" },
    { key: "itemUnits", collection: "byItem" },
    { key: "branches", collection: "byId" },
    { key: "suppliers", collection: "byId" },
    { key: "supplierItems", collection: "bySupplier" },
    { key: "allowedLocalPurchases", collection: "byBranch" }
  ];

  checks.forEach(function(check) {
    const value = data[check.key];
    if (!value || value.sheetExists !== true) {
      issues.push("البيانات المرجعية غير متاحة: " + check.key);
      return;
    }
    if (!value[check.collection] || typeof value[check.collection] !== "object") {
      issues.push("بنية البيانات المرجعية غير صالحة: " + check.key + "." + check.collection);
    }
  });

  return issues;
}

function safeRebuildReferenceCache_() {
  try {
    const schemaStatus = validateInventorySchema_();
    if (!schemaStatus.success) {
      return {
        success: false,
        message: "تم إيقاف إعادة بناء الذاكرة المؤقتة لأن بنية الجداول تحتوي على مشاكل.",
        issues: schemaStatus.issues || [],
        schema: schemaStatus
      };
    }

    const clearResult = clearReferenceCache_();
    if (!clearResult.success) return clearResult;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const referenceData = rebuildReferenceData_(ss);
    const referenceIssues = validateReferenceDataShape_(referenceData);
    if (referenceIssues.length) {
      return {
        success: false,
        message: "تمت إعادة بناء الذاكرة المؤقتة لكن فحص البيانات المرجعية أظهر مشاكل.",
        issues: referenceIssues
      };
    }
    return { success: true, message: "تم مسح وإعادة بناء ذاكرة البيانات المرجعية المؤقتة بنجاح." };
  } catch (e) {
    console.error("safeRebuildReferenceCache_ failed", e);
    return { success: false, message: "تعذر إعادة بناء ذاكرة البيانات المرجعية المؤقتة حالياً." };
  }
}

function safeRebuildReferenceCache(sessionToken) {
  try {
    requireOwnerForAdmin_(sessionToken);
    return safeRebuildReferenceCache_();
  } catch (e) {
    console.error("safeRebuildReferenceCache failed", e);
    return { success: false, message: "تعذر إعادة بناء ذاكرة البيانات المرجعية المؤقتة حالياً." };
  }
}

function adminRefreshReferenceCache(sessionToken) {
  return safeRebuildReferenceCache(sessionToken);
}

function getCachedReferenceData_(cacheKey, ttlSeconds, builderFn) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      logReferenceCacheParseFailure_(cacheKey, e);
      // Cache is an acceleration layer only; invalid JSON is rebuilt from the sheet.
    }
  }

  const rebuilt = builderFn();
  try {
    cache.put(cacheKey, JSON.stringify(rebuilt), ttlSeconds);
  } catch (e) {
    // Large reference tables can exceed CacheService limits. Keep the app correct without cache.
  }
  return rebuilt;
}

function getReferenceItems_(ss) {
  return getCachedReferenceData_("ref_items_v1", 1800, function() {
    const itemsSheet = getSheetByNameCaseInsensitive_(ss, "Items");
    const result = { sheetExists: !!itemsSheet, byId: {}, itemOrder: [] };
    if (!itemsSheet) return result;

    const headerMap = requireHeaderColumns_(itemsSheet, getInventorySchemaRequirements_().Items);
    const itemsData = itemsSheet.getDataRange().getValues();
    for (let i = 1; i < itemsData.length; i++) {
      const row = itemsData[i];
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      if (!itemId) continue;
      const item = {
        itemId: itemId,
        id: itemId,
        nameAr: String(getCellByHeader_(row, headerMap, "name_ar") || "").trim(),
        baseUnit: String(getCellByHeader_(row, headerMap, "base_unit") || "").trim(),
        sortOrder: parseSheetNumber_(getCellByHeader_(row, headerMap, "sort_order"), 999999999)
      };
      result.byId[itemId] = item;
      result.itemOrder.push({
        itemId: item.itemId,
        nameAr: item.nameAr,
        baseUnit: item.baseUnit,
        sortOrder: item.sortOrder
      });
    }
    sortItemsByCustomOrder_(result.itemOrder);
    return result;
  });
}

function getReferenceItemUnits_(ss) {
  return getCachedReferenceData_("ref_item_units_v1", 1800, function() {
    const unitsSheet = getSheetByNameCaseInsensitive_(ss, "Item_Units");
    const result = { sheetExists: !!unitsSheet, byItem: {} };
    if (!unitsSheet) return result;

    const headerMap = requireHeaderColumns_(unitsSheet, getInventorySchemaRequirements_().Item_Units);
    const unitsData = unitsSheet.getDataRange().getValues();
    for (let i = 1; i < unitsData.length; i++) {
      const row = unitsData[i];
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      const unitName = String(getCellByHeader_(row, headerMap, "unit_name") || "").trim();
      const conversionRate = parseNumericInput_(getCellByHeader_(row, headerMap, "conversion_rate"));
      if (!itemId || !unitName) continue;
      if (!result.byItem[itemId]) result.byItem[itemId] = [];
      result.byItem[itemId].push({
        unitName: unitName,
        conversionRate: isNaN(conversionRate) ? 1 : conversionRate
      });
    }
    return result;
  });
}

function getReferenceBranches_(ss) {
  return getCachedReferenceData_("ref_branches_v1", 1800, function() {
    const branchesSheet = getSheetByNameCaseInsensitive_(ss, "branches");
    const result = { sheetExists: !!branchesSheet, byId: {}, byName: {}, activeBranches: [] };
    if (!branchesSheet) return result;

    const headerMap = requireHeaderColumns_(branchesSheet, getInventorySchemaRequirements_().branches);
    const branchesData = branchesSheet.getDataRange().getValues();
    for (let i = 1; i < branchesData.length; i++) {
      const row = branchesData[i];
      const id = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
      const nameAr = String(getCellByHeader_(row, headerMap, "name_ar") || "").trim();
      const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
      if (!id) continue;
      const branch = {
        id: id,
        nameAr: nameAr,
        name: nameAr,
        status: status,
        active: status === "active"
      };
      result.byId[id] = branch;
      if (nameAr) result.byName[nameAr.toLowerCase()] = branch;
      if (branch.active && nameAr) result.activeBranches.push({ id: id, name: nameAr });
    }
    return result;
  });
}

function getReferenceSuppliers_(ss) {
  return getCachedReferenceData_("ref_suppliers_v1", 1800, function() {
    const suppliersSheet = getSheetByNameCaseInsensitive_(ss, "Suppliers");
    const result = { sheetExists: !!suppliersSheet, byId: {}, activeSuppliers: [] };
    if (!suppliersSheet) return result;

    const headerMap = requireHeaderColumns_(suppliersSheet, getInventorySchemaRequirements_().Suppliers);
    const suppliersData = suppliersSheet.getDataRange().getValues();
    for (let i = 1; i < suppliersData.length; i++) {
      const row = suppliersData[i];
      const supplierId = String(getCellByHeader_(row, headerMap, "supplier_id") || "").trim();
      const nameAr = String(getCellByHeader_(row, headerMap, "name_ar") || "").trim();
      const phone = String(getCellByHeader_(row, headerMap, "phone") || "").trim();
      const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
      if (!supplierId || !nameAr) continue;
      const supplier = {
        supplierId: supplierId,
        nameAr: nameAr,
        phone: phone,
        status: status,
        active: status === "active"
      };
      result.byId[supplierId] = supplier;
      if (supplier.active) {
        result.activeSuppliers.push({
          supplierId: supplierId,
          nameAr: nameAr,
          phone: phone
        });
      }
    }
    return result;
  });
}

function getReferenceSupplierItems_(ss) {
  return getCachedReferenceData_("ref_supplier_items_v1", 1800, function() {
    const supplierItemsSheet = getSheetByNameCaseInsensitive_(ss, "Supplier_Items");
    const result = { sheetExists: !!supplierItemsSheet, bySupplier: {} };
    if (!supplierItemsSheet) return result;

    const headerMap = requireHeaderColumns_(supplierItemsSheet, getInventorySchemaRequirements_().Supplier_Items);
    const supplierItemsData = supplierItemsSheet.getDataRange().getValues();
    for (let i = 1; i < supplierItemsData.length; i++) {
      const row = supplierItemsData[i];
      const supplierId = String(getCellByHeader_(row, headerMap, "supplier_id") || "").trim();
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
      if (!supplierId || !itemId) continue;
      if (!result.bySupplier[supplierId]) result.bySupplier[supplierId] = {};
      result.bySupplier[supplierId][itemId] = status === "active";
    }
    return result;
  });
}

function getReferenceAllowedLocalPurchases_(ss) {
  return getCachedReferenceData_("ref_allowed_local_purchases_v1", 1800, function() {
    const allowedSheet = getSheetByNameCaseInsensitive_(ss, "Allowed_Local_Purchases");
    const result = { sheetExists: !!allowedSheet, byBranch: {} };
    if (!allowedSheet) return result;

    const headerMap = requireHeaderColumns_(allowedSheet, getInventorySchemaRequirements_().Allowed_Local_Purchases);
    const allowedData = allowedSheet.getDataRange().getValues();
    for (let i = 1; i < allowedData.length; i++) {
      const row = allowedData[i];
      const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      if (!branchId || !itemId) continue;
      if (!result.byBranch[branchId]) result.byBranch[branchId] = {};
      result.byBranch[branchId][itemId] = true;
    }
    return result;
  });
}

function getBranchMap_(ss) {
  const refBranches = getReferenceBranches_(ss);
  return { byId: refBranches.byId || {}, byName: refBranches.byName || {} };
}

function resolveBranchIdFromValue_(ss, branchValue) {
  const value = String(branchValue || "").trim();
  if (!value) return "";
  const branchMap = getBranchMap_(ss);
  if (branchMap.byId[value]) return branchMap.byId[value].id;
  const byName = branchMap.byName[value.toLowerCase()];
  return byName ? byName.id : "";
}

function getUsersIndex_(ss, usersSheet) {
  const sheet = usersSheet || getSheetByNameCaseInsensitive_(ss, "Users");
  const result = {
    byEmployeeNumber: {},
    statusColumn: 6
  };
  if (!sheet) return result;

  const usersData = sheet.getDataRange().getValues();
  if (!usersData.length) return result;

  const headers = usersData[0] || [];
  const employeeColumn = findHeaderColumn_(headers, ["employee_number", "employee number", "رقم الموظف"], 1);
  const pinColumn = findHeaderColumn_(headers, ["pin", "password", "الرمز السري"], 2);
  const nameColumn = findHeaderColumn_(headers, ["name", "employee_name", "اسم الموظف"], 3);
  const roleColumn = findHeaderColumn_(headers, ["role", "الصلاحية", "الدور"], 4);
  const branchColumn = findHeaderColumn_(headers, ["branch", "branch_id", "الفرع"], 5);
  const statusColumn = findHeaderColumn_(headers, ["status", "user_status", "account_status", "الحالة", "حالة الحساب"], 6);
  
  const pinHashColumn = findHeaderColumn_(headers, ["pin_hash"], 0);
  const pinSaltColumn = findHeaderColumn_(headers, ["pin_salt"], 0);
  const pinMigratedAtColumn = findHeaderColumn_(headers, ["pin_migrated_at"], 0);
  
  result.statusColumn = statusColumn;
  result.pinHashColumn = pinHashColumn;
  result.pinSaltColumn = pinSaltColumn;
  result.pinMigratedAtColumn = pinMigratedAtColumn;

  const branchMap = getBranchMap_(ss);
  for (let i = 1; i < usersData.length; i++) {
    const row = usersData[i];
    const employeeNumber = normalizeEmployeeNumber_(row[employeeColumn - 1]);
    if (!employeeNumber) continue;

    const branchValue = String(row[branchColumn - 1] || "").trim();
    const branchByName = branchMap.byName[branchValue.toLowerCase()];
    const branchById = branchMap.byId[branchValue];
    result.byEmployeeNumber[employeeNumber] = {
      rowNumber: i + 1,
      employeeNumber: employeeNumber,
      pin: row[pinColumn - 1],
      pinHash: pinHashColumn > 0 ? row[pinHashColumn - 1] : "",
      pinSalt: pinSaltColumn > 0 ? row[pinSaltColumn - 1] : "",
      pinMigratedAt: pinMigratedAtColumn > 0 ? row[pinMigratedAtColumn - 1] : "",
      pinHashColumn: pinHashColumn,
      pinSaltColumn: pinSaltColumn,
      pinMigratedAtColumn: pinMigratedAtColumn,
      name: row[nameColumn - 1],
      role: normalizeRole_(row[roleColumn - 1]),
      branch: branchValue,
      branchId: branchById ? branchById.id : (branchByName ? branchByName.id : ""),
      status: String(row[statusColumn - 1] || "").trim().toLowerCase()
    };
  }
  return result;
}

function getUserByEmployeeNumberFromIndex_(usersIndex, employeeNumber) {
  const empNumStr = normalizeEmployeeNumber_(employeeNumber);
  if (!empNumStr || !usersIndex || !usersIndex.byEmployeeNumber) return null;
  return usersIndex.byEmployeeNumber[empNumStr] || null;
}

function getUserByEmployeeNumber_(ss, employeeNumber) {
  return getUserByEmployeeNumberFromIndex_(getUsersIndex_(ss), employeeNumber);
}

function resolveTransferSourceBranchForMigration_(usersIndex, createdBy, currentSourceBranch, diagnostics) {
  const current = String(currentSourceBranch || "").trim();
  const createdByNormalized = normalizeEmployeeNumber_(createdBy);
  const counters = diagnostics || {};
  const isDistributorSource = current === "DISTRIBUTOR";

  if (current && !isDistributorSource) {
    counters.preservedExistingBranch = (counters.preservedExistingBranch || 0) + 1;
    return current;
  }

  const user = getUserByEmployeeNumberFromIndex_(usersIndex, createdByNormalized);
  if (user && user.role === "manager" && user.branchId) {
    if (isDistributorSource) {
      counters.repairedManagerDistributorRows = (counters.repairedManagerDistributorRows || 0) + 1;
    } else {
      counters.filledManagerBlankRows = (counters.filledManagerBlankRows || 0) + 1;
    }
    return user.branchId;
  }

  if (user && user.role === "distributor") {
    counters.resolvedDistributorRows = (counters.resolvedDistributorRows || 0) + 1;
    return "DISTRIBUTOR";
  }

  counters.ambiguousRows = (counters.ambiguousRows || 0) + 1;
  return current;
}

function getItemSortOrder_(row, headers) {
  const fallbackSortOrder = 999999999;
  const headerList = Array.isArray(headers) ? headers : [];
  let sortOrderIndex = -1;

  for (let i = 0; i < headerList.length; i++) {
    if (String(headerList[i] || "").trim().toLowerCase() === "sort_order") {
      sortOrderIndex = i;
      break;
    }
  }

  if (sortOrderIndex === -1) return fallbackSortOrder;

  const sortOrder = parseNumericInput_(row[sortOrderIndex]);
  return isNaN(sortOrder) ? fallbackSortOrder : sortOrder;
}

function sortItemsByCustomOrder_(items) {
  const itemList = Array.isArray(items) ? items : [];
  return itemList.sort(function(a, b) {
    const parsedAOrder = parseNumericInput_(a.sortOrder);
    const parsedBOrder = parseNumericInput_(b.sortOrder);
    const aOrder = isNaN(parsedAOrder) ? 999999999 : parsedAOrder;
    const bOrder = isNaN(parsedBOrder) ? 999999999 : parsedBOrder;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return String(a.nameAr || "").localeCompare(String(b.nameAr || ""), "ar");
  });
}

function getItemValidationCatalog_(ss, referenceContext) {
  const context = referenceContext || {};
  const refItems = context.refItems || getReferenceItems_(ss);
  const refUnits = context.refUnits || getReferenceItemUnits_(ss);
  if (!refItems.sheetExists || !refUnits.sheetExists) {
    throw new Error("جداول المنتجات أو الوحدات غير موجودة.");
  }

  const catalog = {};

  Object.keys(refItems.byId || {}).forEach(function(itemId) {
    const refItem = refItems.byId[itemId];
    const baseUnit = String(refItem.baseUnit || "").trim();
    catalog[itemId] = {
      itemId: itemId,
      nameAr: String(refItem.nameAr || "").trim(),
      units: {},
      baseUnit: baseUnit
    };
    if (baseUnit) catalog[itemId].units[baseUnit] = 1;
  });

  Object.keys(refUnits.byItem || {}).forEach(function(itemId) {
    if (!catalog[itemId]) return;
    refUnits.byItem[itemId].forEach(function(unitInfo) {
      const unit = String(unitInfo.unitName || "").trim();
      if (!unit) return;
      const rate = parseNumericInput_(unitInfo.conversionRate);
      catalog[itemId].units[unit] = isNaN(rate) ? 1 : rate;
    });
  });

  return catalog;
}

function validateInventorySchema_() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const schema = getInventorySchemaRequirements_();
    const issues = [];
    const warnings = [];
    const sheets = [];

    Object.keys(schema).forEach(function(sheetName) {
      const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (!sheet) {
        issues.push("جدول " + sheetName + " غير موجود.");
        sheets.push({ name: sheetName, exists: false, missingHeaders: schema[sheetName] });
        return;
      }

      const headerMap = getHeaderMap_(sheet);
      const missingHeaders = getMissingRequiredHeaders_(sheet, schema[sheetName]);
      const aliasWarnings = getSchemaAliasWarnings_(sheetName, headerMap, schema[sheetName]);
      warnings.push.apply(warnings, aliasWarnings);
      if (missingHeaders.length) {
        issues.push("جدول " + sheetName + " ينقصه الأعمدة: " + missingHeaders.join(", "));
      }
      sheets.push({
        name: sheetName,
        exists: true,
        missingHeaders: missingHeaders,
        warnings: aliasWarnings
      });
    });

    if (issues.length) {
      return {
        success: false,
        message: "تم العثور على مشاكل في بنية الجداول.",
        issues: issues,
        warnings: warnings,
        sheets: sheets
      };
    }

    return {
      success: true,
      message: warnings.length ? "بنية جداول نظام المخزون سليمة مع استخدام بعض العناوين البديلة." : "بنية جداول نظام المخزون سليمة.",
      warnings: warnings,
      sheets: sheets
    };
  } catch (e) {
    console.error("validateInventorySchema_ failed", e);
    return { success: false, message: "تعذر فحص بنية الجداول حالياً.", issues: ["تعذر فحص بنية الجداول حالياً."] };
  }
}

function validateInventorySchema(sessionToken) {
  try {
    requireOwnerForAdmin_(sessionToken);
    return validateInventorySchema_();
  } catch (e) {
    console.error("validateInventorySchema failed", e);
    return { success: false, message: "تعذر فحص بنية الجداول حالياً.", issues: ["تعذر فحص بنية الجداول حالياً."] };
  }
}

function getMovementReadModelHealth_(ss) {
  const now = new Date();
  const summarySheet = getSheetByNameCaseInsensitive_(ss, "Movement_Daily_Summary");
  const pendingIndexSheet = getSheetByNameCaseInsensitive_(ss, "Pending_Transfer_Index");
  const archiveSheet = getSheetByNameCaseInsensitive_(ss, "Archive_Control");
  const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
  const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  const summaryRows = summarySheet ? Math.max(0, summarySheet.getLastRow() - 1) : 0;
  const pendingIndexRows = pendingIndexSheet ? Math.max(0, pendingIndexSheet.getLastRow() - 1) : 0;
  const purchaseRows = purchasesSheet ? Math.max(0, purchasesSheet.getLastRow() - 1) : 0;
  const transferRows = transfersSheet ? Math.max(0, transfersSheet.getLastRow() - 1) : 0;
  let lastSummaryUpdate = "";
  let maxPurchaseSummarySourceRow = 0;
  let maxTransferSummarySourceRow = 0;
  let maxPendingIndexTransferRow = 0;
  let coverageReliable = true;
  let coverageMessage = "";

  if (summarySheet && summaryRows > 0) {
    const headerMap = requireHeaderColumns_(summarySheet, getInventorySchemaRequirements_().Movement_Daily_Summary);
    const updatedCol = getHeaderIndex_(headerMap, "updated_at");
    const sourceTypeCol = getHeaderIndex_(headerMap, "source_type");
    const lastSourceRowCol = getHeaderIndex_(headerMap, "last_source_row");
    if (updatedCol > 0 && sourceTypeCol > 0 && lastSourceRowCol > 0) {
      const values = summarySheet.getRange(2, 1, summaryRows, headerMap.__lastColumn).getValues();
      let latest = null;
      values.forEach(function(row) {
        const date = parseSheetDate_(getCellByHeader_(row, headerMap, "updated_at"));
        if (date && (!latest || date.getTime() > latest.getTime())) latest = date;
        const sourceType = String(getCellByHeader_(row, headerMap, "source_type") || "").trim();
        const sourceRow = Number(getCellByHeader_(row, headerMap, "last_source_row") || 0);
        if (sourceType === "purchase" && sourceRow > maxPurchaseSummarySourceRow) maxPurchaseSummarySourceRow = sourceRow;
        if (sourceType === "transfer" && sourceRow > maxTransferSummarySourceRow) maxTransferSummarySourceRow = sourceRow;
      });
      lastSummaryUpdate = latest ? formatDateTimeForClient_(latest) : "";
    } else {
      coverageReliable = false;
    }
  } else if (purchaseRows > 0 || transferRows > 0) {
    coverageReliable = false;
  }

  if (pendingIndexSheet && pendingIndexRows > 0) {
    const indexHeaderMap = requireHeaderColumns_(pendingIndexSheet, getInventorySchemaRequirements_().Pending_Transfer_Index);
    const transferRowCol = getHeaderIndex_(indexHeaderMap, "transfer_row");
    if (transferRowCol > 0) {
      const values = pendingIndexSheet.getRange(2, transferRowCol, pendingIndexRows, 1).getValues();
      values.forEach(function(row) {
        const sourceRow = Number(row[0] || 0);
        if (sourceRow > maxPendingIndexTransferRow) maxPendingIndexTransferRow = sourceRow;
      });
    } else {
      coverageReliable = false;
    }
  } else if (transferRows > 0) {
    coverageReliable = false;
  }

  // Summary readiness is decided by exact expected-vs-actual equality against
  // the raw Purchases/Transfers rows. Row counts, cursors, and last-updated
  // timestamps can never prove a derived summary correct.
  let summaryReconciled = false;
  let summaryExactMatch = false;
  let summaryExpectedKeyCount = 0;
  let summaryActualKeyCount = 0;
  let summaryMissingKeyCount = 0;
  let summaryUnexpectedKeyCount = 0;
  let summaryDuplicateKeyCount = 0;
  let summaryDuplicateRowCount = 0;
  let summaryMalformedRowCount = 0;
  let summaryQuantityMismatchCount = 0;
  let summaryCostMismatchCount = 0;
  let summarySourceTypeMismatches = [];
  let summaryBranchMismatches = [];
  let summarySourceChangedDuringRead = false;
  if (summarySheet) {
    try {
      const summaryVersionBefore = getBalanceSourceVersion_();
      const summaryReconciliation = reconcileMovementSummaryState_(ss, now);
      summarySourceChangedDuringRead = getBalanceSourceVersion_() !== summaryVersionBefore;
      if (summaryReconciliation && summaryReconciliation.available) {
        const c = summaryReconciliation.comparison;
        summaryReconciled = true;
        summaryExactMatch = !!c.exactMatch && !summarySourceChangedDuringRead;
        summaryExpectedKeyCount = c.expectedKeyCount;
        summaryActualKeyCount = c.actualKeyCount;
        summaryMissingKeyCount = c.missingKeyCount;
        summaryUnexpectedKeyCount = c.unexpectedKeyCount;
        summaryDuplicateKeyCount = c.duplicateKeyCount;
        summaryDuplicateRowCount = c.duplicateRowCount;
        summaryMalformedRowCount = c.malformedRowCount;
        summaryQuantityMismatchCount = c.quantityMismatchCount;
        summaryCostMismatchCount = c.costMismatchCount;
        summarySourceTypeMismatches = c.sourceTypeMismatches;
        summaryBranchMismatches = c.branchMismatches;
      }
    } catch (summaryHealthError) {
      console.error("getMovementReadModelHealth_ summary reconciliation failed", summaryHealthError);
      summaryReconciled = false;
    }
  }

  // Pending-index readiness is decided by exact source/index identity
  // equality. The cursor values above stay as diagnostics only: a maximum
  // indexed row can never prove that earlier pending rows were indexed.
  let pendingIndexReconciled = false;
  let pendingIndexExactMatch = false;
  let pendingIndexSourcePendingRows = 0;
  let pendingIndexIndexedPendingRows = 0;
  let pendingIndexMissingRows = 0;
  let pendingIndexStaleRows = 0;
  let pendingIndexDuplicateRows = 0;
  let pendingIndexInvalidSourceRows = 0;
  let pendingIndexBranchMismatches = [];
  if (transfersSheet) {
    try {
      const pendingReconciliation = reconcilePendingTransferIndexState_(ss, "");
      if (pendingReconciliation && pendingReconciliation.available) {
        const comparison = pendingReconciliation.comparison;
        pendingIndexReconciled = true;
        pendingIndexExactMatch = !!comparison.exactMatch;
        pendingIndexSourcePendingRows = comparison.sourcePendingRows;
        pendingIndexIndexedPendingRows = comparison.indexedPendingRows;
        pendingIndexMissingRows = comparison.missingPendingRows;
        pendingIndexStaleRows = comparison.stalePendingRows;
        pendingIndexDuplicateRows = comparison.duplicatePendingRows;
        pendingIndexInvalidSourceRows = comparison.invalidSourceRowCount;
        pendingIndexBranchMismatches = comparison.branchMismatches;
      }
    } catch (pendingIndexError) {
      console.error("getMovementReadModelHealth_ pending index reconciliation failed", pendingIndexError);
      pendingIndexReconciled = false;
    }
  }

  const purchaseLastRow = purchasesSheet ? Math.max(1, purchasesSheet.getLastRow()) : 1;
  const transferLastRow = transfersSheet ? Math.max(1, transfersSheet.getLastRow()) : 1;
  const purchaseRowsAfterSummaryCursor = maxPurchaseSummarySourceRow > 0 ? Math.max(0, purchaseLastRow - maxPurchaseSummarySourceRow) : purchaseRows;
  const transferRowsAfterSummaryCursor = maxTransferSummarySourceRow > 0 ? Math.max(0, transferLastRow - maxTransferSummarySourceRow) : transferRows;
  const pendingTransferRowsAfterIndexCursor = maxPendingIndexTransferRow > 0 ? Math.max(0, transferLastRow - maxPendingIndexTransferRow) : transferRows;
  if (!coverageReliable) {
    coverageMessage = "يلزم تشغيل تحديث ملخصات الحركة للتحقق من اكتمال بيانات القراءة السريعة.";
  }
  if (summaryReconciled && !summaryExactMatch) {
    coverageMessage = "ملخصات الحركة غير مطابقة للبيانات الأصلية. لا يمكن الاعتماد على إجماليات الملخص، ويلزم تشغيل إصلاح ملخصات الحركة.";
  }
  if (!pendingIndexReconciled) {
    coverageMessage = "تعذر التحقق من اكتمال فهرس التحويلات المعلقة. يتم استخدام بيانات التحويلات الأصلية مباشرة.";
  } else if (!pendingIndexExactMatch) {
    coverageMessage = "فهرس التحويلات المعلقة غير مطابق لبيانات التحويلات. يتم عرض الشحنات من المصدر الأصلي، ويلزم تشغيل إعادة بناء الفهرس.";
  }
  const rowsRequiringBackfill = coverageReliable
    ? purchaseRowsAfterSummaryCursor + transferRowsAfterSummaryCursor + pendingTransferRowsAfterIndexCursor
    : "";
  const archiveDiagnostics = {
    ready: !!archiveSheet,
    rows: archiveSheet ? Math.max(0, archiveSheet.getLastRow() - 1) : 0,
    message: "الأرشفة تشخيصية فقط في هذا الإصدار، ولا يتم نقل أو حذف صفوف خام."
  };

  return {
    checkedAt: formatDateTimeForClient_(now),
    summariesReady: !!summarySheet && summaryReconciled && summaryExactMatch,
    summariesReconciled: summaryReconciled,
    summariesExactMatch: summaryExactMatch,
    summaryExpectedKeyCount: summaryExpectedKeyCount,
    summaryActualKeyCount: summaryActualKeyCount,
    summaryMissingKeyCount: summaryMissingKeyCount,
    summaryUnexpectedKeyCount: summaryUnexpectedKeyCount,
    summaryDuplicateKeyCount: summaryDuplicateKeyCount,
    summaryDuplicateRowCount: summaryDuplicateRowCount,
    summaryMalformedRowCount: summaryMalformedRowCount,
    summaryQuantityMismatchCount: summaryQuantityMismatchCount,
    summaryCostMismatchCount: summaryCostMismatchCount,
    summarySourceTypeMismatches: summarySourceTypeMismatches,
    summaryBranchMismatches: summaryBranchMismatches,
    summarySourceChangedDuringRead: summarySourceChangedDuringRead,
    pendingIndexReady: !!pendingIndexSheet && pendingIndexReconciled && pendingIndexExactMatch,
    pendingIndexReconciled: pendingIndexReconciled,
    pendingIndexExactMatch: pendingIndexExactMatch,
    pendingIndexSourcePendingRows: pendingIndexSourcePendingRows,
    pendingIndexIndexedPendingRows: pendingIndexIndexedPendingRows,
    pendingIndexMissingRows: pendingIndexMissingRows,
    pendingIndexStaleRows: pendingIndexStaleRows,
    pendingIndexDuplicateRows: pendingIndexDuplicateRows,
    pendingIndexInvalidSourceRows: pendingIndexInvalidSourceRows,
    pendingIndexBranchMismatches: pendingIndexBranchMismatches,
    summaryRows: summaryRows,
    pendingIndexRows: pendingIndexRows,
    purchaseRows: purchaseRows,
    transferRows: transferRows,
    coverageReliable: coverageReliable,
    maxPurchaseSummarySourceRow: maxPurchaseSummarySourceRow,
    maxTransferSummarySourceRow: maxTransferSummarySourceRow,
    maxPendingIndexTransferRow: maxPendingIndexTransferRow,
    purchaseRowsAfterSummaryCursor: coverageReliable ? purchaseRowsAfterSummaryCursor : "",
    transferRowsAfterSummaryCursor: coverageReliable ? transferRowsAfterSummaryCursor : "",
    pendingTransferRowsAfterIndexCursor: coverageReliable ? pendingTransferRowsAfterIndexCursor : "",
    lastSummaryUpdate: lastSummaryUpdate,
    rowsRequiringBackfill: rowsRequiringBackfill,
    message: coverageMessage,
    archiveDiagnostics: archiveDiagnostics
  };
}

function adminHealthCheck(sessionToken) {
  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    const ss = adminContext.ss;
    const schema = validateInventorySchema_();
    const sheetNames = Object.keys(getInventorySchemaRequirements_()).concat(["Logs"]);
    const rowCounts = {};
    const checks = [];
    let hasWarning = !schema.success || !!(schema.warnings && schema.warnings.length);

    sheetNames.forEach(function(sheetName) {
      const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (!sheet) {
        rowCounts[sheetName] = null;
        const message = "جدول " + sheetName + " غير موجود.";
        checks.push({
          name: "sheet_" + sheetName,
          success: sheetName === "Logs",
          message: message
        });
        hasWarning = true;
        return;
      }
      rowCounts[sheetName] = Math.max(0, sheet.getLastRow() - 1);
      checks.push({
        name: "sheet_" + sheetName,
        success: true,
        message: "جدول " + sheetName + " موجود."
      });
    });

    checks.push({
      name: "schema",
      success: !!schema.success,
      message: schema.message
    });
    (schema.warnings || []).forEach(function(warning, index) {
      checks.push({
        name: "schema_warning_" + (index + 1),
        success: true,
        message: warning
      });
    });
    checks.push({
      name: "clearReferenceCache",
      success: typeof clearReferenceCache_ === "function" && typeof adminClearReferenceCache === "function",
      message: typeof adminClearReferenceCache === "function" ? "دالة مسح الذاكرة المؤقتة متاحة للمالك." : "دالة مسح الذاكرة المؤقتة غير متاحة."
    });
    checks.push({
      name: "safeRebuildReferenceCache",
      success: typeof safeRebuildReferenceCache_ === "function",
      message: typeof safeRebuildReferenceCache_ === "function" ? "دالة إعادة بناء الذاكرة المؤقتة الداخلية متاحة." : "دالة إعادة بناء الذاكرة المؤقتة غير متاحة."
    });
    checks.push({
      name: "adminRefreshReferenceCache",
      success: typeof adminRefreshReferenceCache === "function",
      message: typeof adminRefreshReferenceCache === "function" ? "دالة تحديث ذاكرة البيانات المرجعية متاحة للاستخدام بعد تعديل الجداول المرجعية." : "دالة تحديث ذاكرة البيانات المرجعية غير متاحة."
    });

    const movementReadModelHealth = getMovementReadModelHealth_(ss);
    checks.push({
      name: "movement_daily_summary",
      success: movementReadModelHealth.summariesReady,
      message: movementReadModelHealth.summariesReady ? "ملخصات الحركة جاهزة للقراءة السريعة." : "ملخصات الحركة تحتاج تشغيل تحديث من شاشة المالك."
    });
    checks.push({
      name: "pending_transfer_index",
      success: movementReadModelHealth.pendingIndexReady,
      message: movementReadModelHealth.pendingIndexReady ? "فهرس التحويلات المعلقة جاهز." : "فهرس التحويلات المعلقة يحتاج تشغيل تحديث من شاشة المالك."
    });

    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    if (logsSheet) {
      const logsHeaderMap = getHeaderMap_(logsSheet);
      const missingLogHeaders = ["details", "entity_id", "entity_type"].filter(function(headerName) {
        return !getHeaderIndex_(logsHeaderMap, headerName);
      });
      if (missingLogHeaders.length) {
        hasWarning = true;
        checks.push({
          name: "logs_detail_headers",
          success: false,
          message: "جدول Logs ينقصه أعمدة تفاصيل التدقيق: " + missingLogHeaders.join(", ") + ". سيتم إنشاؤها تلقائياً عند أول تسجيل تفصيلي."
        });
      } else {
        checks.push({
          name: "logs_detail_headers",
          success: true,
          message: "أعمدة تفاصيل التدقيق موجودة في جدول Logs."
        });
      }
    }

    if (schema.success) {
      try {
        const referenceData = rebuildReferenceData_(ss);
        const referenceIssues = validateReferenceDataShape_(referenceData);
        if (referenceIssues.length) {
          hasWarning = true;
          checks.push({
            name: "reference_loaders",
            success: false,
            message: "تمت قراءة البيانات المرجعية لكن بنيتها غير صالحة. جرّب تشغيل adminClearReferenceCache(sessionToken) ثم adminRefreshReferenceCache(sessionToken).",
            issues: referenceIssues
          });
        } else {
          checks.push({
            name: "reference_loaders",
            success: true,
            message: "تمت قراءة البيانات المرجعية بنجاح."
          });
        }
      } catch (referenceError) {
        console.error("adminHealthCheck reference loaders failed", referenceError);
        hasWarning = true;
        checks.push({
          name: "reference_loaders",
          success: false,
          message: "فشلت قراءة البيانات المرجعية رغم سلامة البنية. جرّب تشغيل adminClearReferenceCache(sessionToken) ثم adminRefreshReferenceCache(sessionToken)."
        });
      }
    } else {
      checks.push({
        name: "reference_loaders",
        success: false,
        message: "لم يتم اختبار البيانات المرجعية لأن بنية الجداول تحتوي على مشاكل."
      });
    }

    const status = hasWarning ? "warning" : "ok";
    return {
      success: true,
      status: status,
      message: status === "ok" ? "فحص النظام سليم." : "فحص النظام اكتمل مع تنبيهات.",
      timezone: Session.getScriptTimeZone(),
      schema: schema,
      rowCounts: rowCounts,
      movementReadModel: movementReadModelHealth,
      checks: checks
    };
  } catch (e) {
    console.error("adminHealthCheck failed", e);
    return {
      success: false,
      status: "error",
      message: "تعذر تنفيذ فحص صحة النظام حالياً.",
      timezone: "",
      schema: null,
      rowCounts: {},
      checks: [{ name: "unexpected_error", success: false, message: "تعذر تنفيذ فحص صحة النظام حالياً." }]
    };
  }
}

function adminDataVolumeHealthCheck(sessionToken) {
  const checkedAt = new Date();
  const monitoredSheets = [
    "Transfers",
    "Purchases",
    "Logs",
    "Inventory_Control",
    "Inventory_Counts",
    "Inventory_Count_Lines",
    "Inventory_Balances"
  ];
  const sheets = [];
  const warnings = [];
  let overallStatus = "ok";

  function setOverallStatus_(status) {
    if (status === "high") {
      overallStatus = "high";
    } else if (status === "warning" && overallStatus !== "high") {
      overallStatus = "warning";
    }
  }

  function getVolumeStatus_(dataRows) {
    if (dataRows >= 50000) return "high";
    if (dataRows >= 10000) return "warning";
    return "ok";
  }

  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    const ss = adminContext.ss;
    monitoredSheets.forEach(function(sheetName) {
      const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (!sheet) {
        const missingEntry = {
          sheetName: sheetName,
          exists: false,
          rows: 0,
          dataRows: 0,
          status: "missing",
          message: "الجدول غير موجود حالياً."
        };
        sheets.push(missingEntry);
        warnings.push("جدول " + sheetName + " غير موجود.");
        setOverallStatus_("warning");
        return;
      }

      const rows = sheet.getLastRow();
      const dataRows = Math.max(0, rows - 1);
      const status = getVolumeStatus_(dataRows);
      let message = "حجم البيانات ضمن النطاق الطبيعي.";
      if (status === "warning") {
        message = "حجم البيانات مرتفع ويحتاج متابعة أداء.";
        warnings.push("جدول " + sheetName + " يحتوي على " + dataRows + " صف بيانات.");
      } else if (status === "high") {
        message = "حجم البيانات عالٍ جداً ويحتاج خطة أرشفة أو تحسين قراءة لاحقاً.";
        warnings.push("جدول " + sheetName + " يحتوي على " + dataRows + " صف بيانات.");
      }
      setOverallStatus_(status);

      sheets.push({
        sheetName: sheetName,
        exists: true,
        rows: rows,
        dataRows: dataRows,
        status: status,
        message: message
      });
    });

    return {
      success: true,
      checkedAt: checkedAt,
      sheets: sheets,
      overallStatus: overallStatus,
      warnings: warnings
    };
  } catch (e) {
    console.error("adminDataVolumeHealthCheck failed", e);
    return {
      success: false,
      checkedAt: checkedAt,
      sheets: sheets,
      overallStatus: "error",
      warnings: warnings.concat(["تعذر تنفيذ فحص حجم البيانات حالياً."])
    };
  }
}

function getEmployeeNumbersForBranchFromUsersIndex_(usersIndex, branchId) {
  const targetBranchId = String(branchId || "").trim();
  const result = [];
  if (!targetBranchId || !usersIndex || !usersIndex.byEmployeeNumber) return result;
  Object.keys(usersIndex.byEmployeeNumber).forEach(function(employeeNumber) {
    const user = usersIndex.byEmployeeNumber[employeeNumber];
    if (user && user.role === "manager" && String(user.branchId || "").trim() === targetBranchId) {
      result.push(employeeNumber);
    }
  });
  return result;
}

function getTransferBalanceCandidateRowNumbers_(sheet, headerMap, branchId, usersIndex) {
  const rows = [];
  const branchColumn = getHeaderIndex_(headerMap, "branch");
  const sourceBranchColumn = getHeaderIndex_(headerMap, "source_branch");
  const createdByColumn = getHeaderIndex_(headerMap, "created_by");

  rows.push.apply(rows, getExactTextMatchedRowNumbers_(sheet, branchColumn, branchId));
  rows.push.apply(rows, getExactTextMatchedRowNumbers_(sheet, sourceBranchColumn, branchId));

  getEmployeeNumbersForBranchFromUsersIndex_(usersIndex, branchId).forEach(function(employeeNumber) {
    rows.push.apply(rows, getExactTextMatchedRowNumbers_(sheet, createdByColumn, employeeNumber));
  });

  return uniqueSortedRowNumbers_(rows);
}

function validateTransferItems_(ss, itemsArray, options) {
  if (!Array.isArray(itemsArray) || itemsArray.length === 0) {
    throw new Error("يجب إضافة مادة واحدة على الأقل قبل الإرسال.");
  }

  const catalog = getItemValidationCatalog_(ss);
  const validItems = [];

  for (let i = 0; i < itemsArray.length; i++) {
    const item = itemsArray[i] || {};
    const itemId = String(item.itemId || "").trim();
    const unit = String(item.unit || "").trim();
    const quantity = parseNumericInput_(item.quantity);
    const cost = parseTransferCost_(item, options);

    if (!itemId || !catalog[itemId]) {
      throw new Error("تم رفض صنف غير موجود في بيانات المنتجات.");
    }
    if (!unit || !catalog[itemId].units.hasOwnProperty(unit)) {
      throw new Error("تم رفض وحدة غير صالحة للصنف: " + catalog[itemId].nameAr);
    }
    if (!isFinite(quantity) || quantity <= 0) {
      throw new Error("يجب أن تكون الكمية أكبر من الصفر للصنف: " + catalog[itemId].nameAr);
    }
    if (/^=/.test(String(item.note || "").trim())) throw new Error("ملاحظة غير صالحة.");
    if (!isFinite(quantity * catalog[itemId].units[unit])) throw new Error("Invalid normalized quantity");
    validItems.push({
      itemId: itemId,
      unit: unit,
      quantity: quantity,
      cost: cost,
      note: String(item.note || "").trim(),
      normalizedQuantity: quantity * catalog[itemId].units[unit]
    });
  }

  return validItems;
}

function createReceiptToken_(rowIndex, branchId, transferId, itemId, quantity, unit, normalizedQty, cacheValues) {
  const token = Utilities.getUuid() + "-" + new Date().getTime();
  const key = "receipt_" + token;
  const value = JSON.stringify({
      rowIndex: rowIndex,
      branchId: String(branchId || "").trim(),
      transferId: String(transferId || "").trim(),
      itemId: String(itemId || "").trim(),
      quantity: parseSheetNumber_(quantity),
      unit: String(unit || "").trim(),
      normalizedQty: parseSheetNumber_(normalizedQty)
    });
  if (cacheValues) cacheValues[key] = value;
  else CacheService.getScriptCache().put(key, value, 7200);
  return token;
}

function resolveReceiptToken_(receiptToken) {
  const token = String(receiptToken || "").trim();
  if (!token) {
    throw new Error("بيانات الاستلام غير صالحة. الرجاء تحديث الشاشة والمحاولة مجدداً.");
  }
  const cache = CacheService.getScriptCache();
  const cacheKey = "receipt_" + token;
  const cached = cache.get(cacheKey);
  if (!cached) {
    throw new Error("انتهت صلاحية بيانات الاستلام. الرجاء تحديث الشاشة والمحاولة مجدداً.");
  }
  try {
    const receiptRef = JSON.parse(cached);
    cache.remove(cacheKey);
    return receiptRef;
  } catch (e) {
    throw new Error("بيانات الاستلام غير صالحة. الرجاء تحديث الشاشة والمحاولة مجدداً.");
  }
}

function getTransferMutationToken(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager"]);
    ensureRuntimeSchemaReady_();
    const action = user.role === "manager" ? "submit_manager_branch_transfer" : "submit_distributor_transfer";
    return { success: true, token: createMutationToken_(user.employeeNumber, action, 600) };
  } catch (e) {
    console.error("getTransferMutationToken failed", e);
    return { success: false, message: "تعذر تجهيز الإرسال. لم نرسل طلبًا جديدًا؛ احتفظ بالطلب وحاول لاحقًا أو تواصل مع الإدارة." };
  }
}

function getReceiptMutationToken(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    return { success: true, token: createMutationToken_(user.employeeNumber, "submit_branch_receipt", 600) };
  } catch (e) {
    console.error("getReceiptMutationToken failed", e);
    return { success: false, message: "تعذر تجهيز اعتماد الاستلام. لم يُرسل الاستلام؛ احتفظ بالكميات المدخلة وحاول لاحقًا أو تواصل مع الإدارة." };
  }
}

function submitBulkTransfer(targetBranch, itemsArray, sessionToken, mutationToken, submissionId) {
  let lock = null;
  let lockAcquired = false;
  let businessWriteCommitted = false;
  let transferId = "";
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager"]);
    requireInventorySubmissionId_(submissionId);
    ensureRuntimeSchemaReady_();
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    lockAcquired = true;
    const currentUser = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager"]);
    if (inventorySubmissionJson_([currentUser.employeeNumber,currentUser.role,currentUser.branchId]) !== inventorySubmissionJson_([user.employeeNumber,user.role,user.branchId])) throw new Error("Session changed");
    const payload = {targetBranch:targetBranch, items:itemsArray};
    const existing = readInventorySubmission_(ss,user,'transfer',submissionId,payload);
    if (existing) return reconcileInventorySubmission_(ss,existing);
    assertSubmissionBalancesReady_(ss);

    const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    const now = new Date();
    if (!transfersSheet) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "جدول Transfers غير موجود.");
    }
    const transfersHeaderMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);

    const mutationAction = user.role === "manager" ? "submit_manager_branch_transfer" : "submit_distributor_transfer";

    // التحقق من صلاحية الفرع المستهدف وأنه نشط
    const targetBranchId = String(targetBranch || "").trim();
    requireActiveBranch_(ss, targetBranchId);
    if (user.role === "manager") {
      if (!user.branchId) {
        return inventorySubmissionResult_("NOT_SAVED", submissionId, "تعذر تحديد فرع المدير الحالي.");
      }
      if (user.branchId === targetBranchId) {
        return inventorySubmissionResult_("NOT_SAVED", submissionId, "لا يمكن إرسال تحويل إلى نفس فرع المدير.");
      }
    }

    const validItems = validateTransferItems_(ss, itemsArray, { requireCost: user.role === "distributor" });
    
    // توليد رقم تحويلة موحد للشحنة المجمعة بالكامل (Bulk Transfer ID)
    transferId = "TRF-" + submissionId;
    
    // مصفوفة لتجميع الأسطر الجديدة لصبها دفعة واحدة في الشيت (تحسين أداء مذهل)
    let rowsToAppend = [];
    const sourceBranchVal = user.role === "manager" ? user.branchId : "DISTRIBUTOR";
    
    for (let i = 0; i < validItems.length; i++) {
      const item = validItems[i];
      rowsToAppend.push(buildRowByHeaders_(transfersHeaderMap, {
        transfer_id: transferId,
        branch: targetBranchId,
        source_branch: sourceBranchVal,
        item_id: item.itemId,
        quantity: item.quantity,
        unit: item.unit,
        normalized_quantity: item.normalizedQuantity,
        cost: item.cost,
        status: "pending",      // الحالة الافتراضية عند الإرسال (معلق)
        missing_qty: 0,         // النواقص (0 عند الإرسال، ترصد عند الاستلام)
        note: item.note,
        created_by: user.employeeNumber,
        created_at: now
      }));
    }

    const lockedUser = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager"]);
    if (
      lockedUser.employeeNumber !== user.employeeNumber ||
      lockedUser.role !== user.role ||
      String(lockedUser.branchId || "") !== String(user.branchId || "")
    ) {
      throw new Error("تغيرت بيانات الجلسة. الرجاء تحديث الشاشة والمحاولة من جديد.");
    }
    requireActiveBranch_(ss, targetBranchId);
    if (lockedUser.role === "manager") {
      if (!lockedUser.branchId) {
        return inventorySubmissionResult_("NOT_SAVED", submissionId, "تعذر تحديد فرع المدير الحالي.");
      }
      if (lockedUser.branchId === targetBranchId) {
        return inventorySubmissionResult_("NOT_SAVED", submissionId, "لا يمكن إرسال تحويل إلى نفس فرع المدير.");
      }
    }
    consumeMutationToken_(mutationToken, lockedUser.employeeNumber, mutationAction);
    
    // حقن البيانات في السطر التالي مباشرة دفعة واحدة بدون Loops بطيئة
    if (rowsToAppend.length > 0) {
      const lastRow = transfersSheet.getLastRow();
      const startRow = lastRow + 1;
      const numRows = rowsToAppend.length;
      const numCols = transfersHeaderMap.__lastColumn;

      const saved = saveInventorySubmission_(ss, user, 'transfer', submissionId, payload, transfersSheet, getInventorySchemaRequirements_().Transfers, rowsToAppend);
      if (!saved.committed) return saved;
      businessWriteCommitted = true;
      try {
        const summaryEntries = [];
        const pendingIndexEntries = [];
        rowsToAppend.forEach(function(row, index) {
          const sourceRow = startRow + index;
          summaryEntries.push.apply(summaryEntries, buildTransferSummaryEntriesFromRow_(row, transfersHeaderMap, sourceRow, now, "created"));
          pendingIndexEntries.push(buildPendingTransferIndexEntryFromRow_(row, transfersHeaderMap, sourceRow, now));
        });
        upsertMovementDailySummaries_(ss, summaryEntries, { updatedAt: now });
        upsertPendingTransferIndexRows_(ss, pendingIndexEntries);
      } catch (summaryError) {
        console.error("submitBulkTransfer movement summary update failed", summaryError);
        logMovementSummaryFailure_(logsSheet, user, {
          flow: "submitBulkTransfer",
          transferId: transferId,
          targetBranchId: targetBranchId
        }, summaryError, now);
      }
    }
    
    // تسجيل العملية في السجلات
    const transferLogAction = user.role === "manager"
      ? "SUBMIT_MANAGER_BRANCH_TRANSFER"
      : "SUBMIT_BULK_TRANSFER";
    const auditResult = tryLogCommittedAction_(transferLogAction, lockedUser.employeeNumber + " created transfer " + transferId, {
      entityId: transferId,
      entityType: "transfer",
      transferId: transferId,
      role: lockedUser.role,
      targetBranchId: targetBranchId,
      itemCount: validItems.length
    }, logsSheet, now);
    
    return {
      success: true,
      committed: businessWriteCommitted,
      outcome: "COMMITTED",
      submissionId: submissionId,
      warning: auditResult.warning,
      transferId: transferId
    };
    
  } catch (e) {
    console.error("submitBulkTransfer failed", e);
    if (businessWriteCommitted) {
      return {
        success: true,
        committed: true,
        outcome: "COMMITTED",
        submissionId: submissionId,
        warning: "تم حفظ العملية، لكن تعذر إكمال تسجيلات ما بعد الحفظ حالياً. لا تعِد إرسال العملية.",
        transferId: transferId
      };
    }
    return inventorySubmissionFailure_(e, submissionId);
  } finally {
    if (lockAcquired && lock) lock.releaseLock();
  }
}

function submitManagerBranchTransfer(targetBranch, itemsArray, sessionToken, mutationToken, submissionId) {
  return submitBulkTransfer(targetBranch, itemsArray, sessionToken, mutationToken, submissionId);
}

function getSentTransfersLogForUserR01Read_(ss, user) {
  try {
    const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");

    if (!transfersSheet) return { success: false, message: "جدول Transfers غير موجود." };
    const transfersHeaderMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);

    const recentRows = getRecentSheetRows_(transfersSheet, transfersHeaderMap, 2000);
    const transfersData = recentRows.values;
    const refItems = getReferenceItems_(ss);
    const refBranches = getReferenceBranches_(ss);
    const itemNames = {};
    Object.keys(refItems.byId || {}).forEach(function(id) {
      itemNames[id] = String(refItems.byId[id].nameAr || "منتج غير معروف");
    });

    const branchNames = {};
    Object.keys(refBranches.byId || {}).forEach(function(id) {
      branchNames[id] = String(refBranches.byId[id].nameAr || "").trim();
    });

    const grouped = {};
    const empIdStr = user.employeeNumber;
    
    // تاريخ بداية الفرز (آخر 7 أيام)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    for (let i = 0; i < transfersData.length; i++) {
      const row = transfersData[i];
      if (String(getCellByHeader_(row, transfersHeaderMap, "created_by") || "").trim() !== empIdStr) continue;

      const createdAtValue = getCellByHeader_(row, transfersHeaderMap, "created_at");
      const rowDate = parseSheetDate_(createdAtValue);
      if (!rowDate) continue; // Skip invalid or empty dates
      // تصفية الشحنات لتكون للأسبوع الحالي فقط
      if (rowDate < sevenDaysAgo) continue;

      const transferId = String(getCellByHeader_(row, transfersHeaderMap, "transfer_id") || "TRF-UNKNOWN");
      const branchId = String(getCellByHeader_(row, transfersHeaderMap, "branch") || "").trim();
      
      if (!grouped[transferId]) {
        grouped[transferId] = {
          transferId: transferId,
          branchId: branchId,
          branchName: branchNames[branchId] || branchId || "فرع غير معروف",
          createdAt: formatDateTimeForClient_(rowDate),
          createdAtSort: rowDate.getTime(),
          items: []
        };
      }

      const itemId = String(getCellByHeader_(row, transfersHeaderMap, "item_id") || "");
      grouped[transferId].items.push({
        itemName: itemNames[itemId] || "منتج غير معروف",
        quantity: preserveSheetText_(getCellByHeader_(row, transfersHeaderMap, "quantity"), "0"),
        unit: preserveSheetText_(getCellByHeader_(row, transfersHeaderMap, "unit"), ""),
        cost: parseSheetNumber_(getCellByHeader_(row, transfersHeaderMap, "cost"), 0),
        status: String(getCellByHeader_(row, transfersHeaderMap, "status") || "pending"),
        missingQty: preserveSheetText_(getCellByHeader_(row, transfersHeaderMap, "missing_qty"), "0"),
        note: String(getCellByHeader_(row, transfersHeaderMap, "note") || "")
      });
    }

    const transfers = Object.keys(grouped).map(function(k) { return grouped[k]; });
    // الفرز من الأحدث إلى الأقدم
    transfers.sort(function(a, b) { 
      return (b.createdAtSort || 0) - (a.createdAtSort || 0); 
    });
    transfers.forEach(function(transfer) {
      delete transfer.createdAtSort;
    });

    return { success: true, transfers: transfers };
  } catch (e) {
    console.error("getSentTransfersLogForUser_ failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getSentTransfersLog(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager"]);
    return getSentTransfersLogForUser_(ss, user);
  } catch (e) {
    console.error("getSentTransfersLog failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getPendingTransferRowsForBranch_(transfersSheet, transfersHeaderMap, branchId) {
  const lastRow = transfersSheet.getLastRow();
  const totalDataRows = Math.max(0, lastRow - 1);
  if (totalDataRows === 0) {
    return { rows: [], scannedRows: 0, totalRows: 0 };
  }

  const resolvedBranchId = String(branchId || "").trim();
  const transfersData = transfersSheet.getRange(2, 1, totalDataRows, transfersHeaderMap.__lastColumn).getValues();
  const pendingRows = [];
  for (let i = 0; i < transfersData.length; i++) {
    const row = transfersData[i];
    const rowBranch = String(getCellByHeader_(row, transfersHeaderMap, "branch") || "").trim();
    const status = String(getCellByHeader_(row, transfersHeaderMap, "status") || "").trim().toLowerCase();
    if (rowBranch !== resolvedBranchId || status !== "pending") continue;
    pendingRows.push({ rowNumber: i + 2, row: row });
  }
  return { rows: pendingRows, scannedRows: transfersData.length, totalRows: totalDataRows };
}

function readTransferRowsByRowNumber_(transfersSheet, transfersHeaderMap, rowNumbers) {
  const sortedRows = [];
  const seenRows = {};
  (rowNumbers || []).forEach(function(rowNumberRaw) {
    const rowNumber = parseInt(rowNumberRaw, 10);
    if (isNaN(rowNumber) || rowNumber < 2 || seenRows[rowNumber]) return;
    seenRows[rowNumber] = true;
    sortedRows.push(rowNumber);
  });
  sortedRows.sort(function(a, b) { return a - b; });
  if (!sortedRows.length) return {};

  const firstRow = sortedRows[0];
  const lastRow = sortedRows[sortedRows.length - 1];
  const values = transfersSheet.getRange(firstRow, 1, lastRow - firstRow + 1, transfersHeaderMap.__lastColumn).getValues();
  const byRowNumber = {};
  sortedRows.forEach(function(rowNumber) {
    byRowNumber[rowNumber] = values[rowNumber - firstRow];
  });
  return byRowNumber;
}

function getPendingTransferRowsFromCurrentIndex_(transfersSheet, transfersHeaderMap, indexData, indexHeaderMap, branchId, sourcePendingRows) {
  // Completeness is proven by exact identity-set equality between the live
  // branch-scoped pending source rows and the branch-scoped pending index
  // rows. A maximum indexed row is never accepted as proof of completeness:
  // it cannot see earlier pending rows that were never indexed.
  const resolvedBranchId = String(branchId || "").trim();
  const sourceMap = buildPendingTransferSourceIdentityMap_(sourcePendingRows, transfersHeaderMap);
  const indexMap = buildPendingTransferIndexIdentityMap_(
    indexData,
    indexHeaderMap,
    resolvedBranchId,
    transfersSheet.getLastRow()
  );
  const comparison = comparePendingTransferIdentityMaps_(sourceMap, indexMap);

  // Only identities that are still pending in the live source AND present in
  // the index are served from the index path.
  const pendingRows = [];
  (sourcePendingRows || []).forEach(function(entry) {
    const key = buildPendingTransferIdentityKeyFromSourceRow_(entry.row, transfersHeaderMap, entry.rowNumber);
    if (!key || !indexMap.byKey[key]) return;
    pendingRows.push({ rowNumber: entry.rowNumber, row: entry.row });
  });

  let reason = "";
  if (comparison.missingPendingRows) reason = "index_missing_source_identities";
  else if (comparison.stalePendingRows) reason = "stale_index_rows";
  else if (comparison.duplicatePendingRows) reason = "duplicate_index_identities";
  else if (comparison.malformedIndexRows) reason = "malformed_index_rows";
  else if (!comparison.exactMatch) reason = "index_not_proven_complete";

  return {
    current: comparison.exactMatch,
    exactMatch: comparison.exactMatch,
    staleIndexRows: comparison.stalePendingRows,
    missingIndexRows: comparison.missingPendingRows,
    duplicateIndexRows: comparison.duplicatePendingRows,
    malformedIndexRows: comparison.malformedIndexRows,
    sourcePendingRows: comparison.sourcePendingRows,
    indexedPendingRows: comparison.indexedPendingRows,
    rows: pendingRows,
    reason: reason
  };
}

function buildPendingTransferPayload_(pendingRows, transfersHeaderMap, branchId, itemNames) {
  const resolvedBranchId = String(branchId || "").trim();
  const namesByItemId = itemNames || {};
  const cacheValues = {};
  const payload = (pendingRows || []).map(function(entry) {
    const row = entry.row;
    const itmId = String(getCellByHeader_(row, transfersHeaderMap, "item_id") || "");
    const transferId = String(getCellByHeader_(row, transfersHeaderMap, "transfer_id") || "");
    const quantity = getCellByHeader_(row, transfersHeaderMap, "quantity");
    const unit = getCellByHeader_(row, transfersHeaderMap, "unit");
    const normalizedQty = getCellByHeader_(row, transfersHeaderMap, "normalized_quantity");
    return {
      receiptToken: createReceiptToken_(entry.rowNumber, resolvedBranchId, transferId, itmId, quantity, unit, normalizedQty, cacheValues),
      transferId: transferId,
      itemId: itmId,
      itemName: namesByItemId[itmId] || "منتج غير معروف",
      quantity: preserveSheetText_(quantity, "0"),
      unit: preserveSheetText_(unit, ""),
      normalizedQty: preserveSheetText_(normalizedQty, "0"),
      createdBy: String(getCellByHeader_(row, transfersHeaderMap, "created_by") || ""),
      createdAt: formatDateTimeForClient_(getCellByHeader_(row, transfersHeaderMap, "created_at"))
    };
  });
  if (payload.length) CacheService.getScriptCache().putAll(cacheValues, 7200);
  return payload;
}

function getBranchPendingTransfersForUserR01Read_(ss, user) {
  try {
    const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
    const pendingIndexSheet = getSheetByNameCaseInsensitive_(ss, "Pending_Transfer_Index");

    const refItems = getReferenceItems_(ss);
    if (!transfersSheet || !refItems.sheetExists) {
      return { success: false, message: "تعذر تحميل الشحنات حاليًا. تواصل مع الإدارة للتأكد من القائمة." };
    }
    const transfersHeaderMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);

    const resolvedBranchId = user.branchId;
    if (!resolvedBranchId) {
      return { success: true, transfers: [] };
    }
    requireActiveBranch_(ss, resolvedBranchId);

    let itemNames = {};
    Object.keys(refItems.byId || {}).forEach(function(id) {
      itemNames[id] = String(refItems.byId[id].nameAr || "منتج غير معروف");
    });

    // Transfers is the source of truth. The branch-scoped pending source rows
    // are always read first so a broken derived index can never hide a valid
    // pending transfer from the manager.
    const sourceVersionBeforeRead = getBalanceSourceVersion_();
    const fullScan = getPendingTransferRowsForBranch_(transfersSheet, transfersHeaderMap, resolvedBranchId);

    let indexResult = null;
    if (pendingIndexSheet && pendingIndexSheet.getLastRow() > 1) {
      const indexHeaderMap = requireHeaderColumns_(pendingIndexSheet, getInventorySchemaRequirements_().Pending_Transfer_Index);
      const indexData = pendingIndexSheet.getRange(2, 1, pendingIndexSheet.getLastRow() - 1, indexHeaderMap.__lastColumn).getValues();
      indexResult = getPendingTransferRowsFromCurrentIndex_(
        transfersSheet,
        transfersHeaderMap,
        indexData,
        indexHeaderMap,
        resolvedBranchId,
        fullScan.rows
      );
    }

    // If transfer data moved between the source read and the index read, the
    // comparison cannot certify completeness. Serve the complete source rows
    // and report the index as unproven rather than healthy.
    const sourceStable = getBalanceSourceVersion_() === sourceVersionBeforeRead;
    const indexHealthy = !!indexResult && indexResult.exactMatch === true && sourceStable;
    const servedRows = indexHealthy ? indexResult.rows : fullScan.rows;

    return {
      success: true,
      transfers: buildPendingTransferPayload_(servedRows, transfersHeaderMap, resolvedBranchId, itemNames),
      usedIndex: indexHealthy,
      usedFallback: !indexHealthy,
      indexUsed: indexHealthy,
      fallbackUsed: !indexHealthy,
      indexHealthy: indexHealthy,
      indexPresent: !!indexResult,
      sourcePendingRows: fullScan.rows.length,
      indexedPendingRows: indexResult ? indexResult.indexedPendingRows : 0,
      missingPendingRows: indexResult ? indexResult.missingIndexRows : fullScan.rows.length,
      stalePendingRows: indexResult ? indexResult.staleIndexRows : 0,
      duplicatePendingRows: indexResult ? indexResult.duplicateIndexRows : 0,
      staleIndexRows: indexResult ? indexResult.staleIndexRows : 0,
      indexReason: indexHealthy ? "" : (indexResult ? indexResult.reason : "index_absent"),
      sourceChangedDuringRead: !sourceStable,
      scanLimited: false,
      scanLimit: "",
      scannedRows: fullScan.scannedRows,
      // The manager always receives the complete pending set, so no
      // user-facing warning is raised; degradation is reported to the owner
      // health screen through the metadata above.
      warning: ""
    };

  } catch (e) {
    console.error("getBranchPendingTransfersForUser_ failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getBranchPendingTransfers(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    return getBranchPendingTransfersForUser_(ss, user);
  } catch (e) {
    console.error("getBranchPendingTransfers failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, column, fieldName) {
  const updates = (receiptUpdates || []).slice().sort(function(a, b) {
    return a.row - b.row;
  });
  let rangeStartRow = null;
  let values = [];
  let previousRow = null;

  function flushRange_() {
    if (rangeStartRow === null || values.length === 0) return;
    sheet.getRange(rangeStartRow, column, values.length, 1).setValues(values);
  }

  updates.forEach(function(update) {
    if (rangeStartRow === null) {
      rangeStartRow = update.row;
      previousRow = update.row;
      values = [[update[fieldName]]];
      return;
    }

    if (update.row === previousRow + 1) {
      values.push([update[fieldName]]);
      previousRow = update.row;
      return;
    }

    flushRange_();
    rangeStartRow = update.row;
    previousRow = update.row;
    values = [[update[fieldName]]];
  });

  flushRange_();
}

function writeReceiptUpdates_(sheet, receiptUpdates, columns) {
  if (!receiptUpdates || receiptUpdates.length === 0) return;
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.missingQty, "missingQty");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.note, "note");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.receivedQuantity, "receivedQuantity");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.receivedUnit, "receivedUnit");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.receivedNormalizedQuantity, "receivedNormalizedQuantity");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.receivedAt, "receivedAt");
  writeReceiptUpdateColumnRanges_(sheet, receiptUpdates, columns.receivedBy, "receivedBy");
}

function receiptNumbersMatch_(actualValue, expectedValue) {
  const actualNumber = actualValue === 0 ? 0 : parseNumericInput_(actualValue);
  const expectedNumber = expectedValue === 0 ? 0 : parseNumericInput_(expectedValue);
  return !isNaN(actualNumber) && !isNaN(expectedNumber) && Math.abs(actualNumber - expectedNumber) <= 0.000001;
}

function receiptDatesMatch_(actualValue, expectedValue) {
  const actualDate = parseSheetDate_(actualValue);
  const expectedDate = parseSheetDate_(expectedValue);
  return !!actualDate && !!expectedDate && Math.abs(actualDate.getTime() - expectedDate.getTime()) <= 1;
}

function receiptRowMetadataMatches_(rowData, transfersHeaderMap, update) {
  if (!rowData) return false;
  return (
    String(getCellByHeader_(rowData, transfersHeaderMap, "branch") || "").trim() === update.branchId &&
    String(getCellByHeader_(rowData, transfersHeaderMap, "transfer_id") || "").trim() === update.transferId &&
    String(getCellByHeader_(rowData, transfersHeaderMap, "item_id") || "").trim() === update.itemId &&
    receiptNumbersMatch_(getCellByHeader_(rowData, transfersHeaderMap, "missing_qty"), update.missingQty) &&
    String(getCellByHeader_(rowData, transfersHeaderMap, "note") || "") === update.note &&
    receiptNumbersMatch_(getCellByHeader_(rowData, transfersHeaderMap, "received_quantity"), update.receivedQuantity) &&
    String(getCellByHeader_(rowData, transfersHeaderMap, "received_unit") || "").trim() === update.receivedUnit &&
    receiptNumbersMatch_(getCellByHeader_(rowData, transfersHeaderMap, "received_normalized_quantity"), update.receivedNormalizedQuantity) &&
    receiptDatesMatch_(getCellByHeader_(rowData, transfersHeaderMap, "received_at"), update.receivedAt) &&
    String(getCellByHeader_(rowData, transfersHeaderMap, "received_by") || "").trim() === update.receivedBy
  );
}

function readReceiptRowsForVerification_(sheet, receiptUpdates, transfersHeaderMap) {
  const updates = (receiptUpdates || []).slice().sort(function(a, b) {
    return a.row - b.row;
  });
  if (updates.length === 0) {
    return { startRow: 0, endRow: 0, rows: [] };
  }
  const startRow = updates[0].row;
  const endRow = updates[updates.length - 1].row;
  return {
    startRow: startRow,
    endRow: endRow,
    rows: sheet.getRange(startRow, 1, endRow - startRow + 1, transfersHeaderMap.__lastColumn).getValues()
  };
}

function verifyReceiptMetadata_(sheet, receiptUpdates, transfersHeaderMap) {
  const readback = readReceiptRowsForVerification_(sheet, receiptUpdates, transfersHeaderMap);
  (receiptUpdates || []).forEach(function(update) {
    const rowData = readback.rows[update.row - readback.startRow];
    const status = String(getCellByHeader_(rowData, transfersHeaderMap, "status") || "").trim().toLowerCase();
    if (status !== "pending" || !receiptRowMetadataMatches_(rowData, transfersHeaderMap, update)) {
      throw new Error("Receipt metadata verification failed before status commit at row " + update.row + ".");
    }
  });
}

function commitReceiptStatuses_(sheet, receiptUpdates, columns) {
  const updates = (receiptUpdates || []).slice().sort(function(a, b) {
    return a.row - b.row;
  });
  if (updates.length === 0) return null;

  const startRow = updates[0].row;
  const endRow = updates[updates.length - 1].row;
  const statusRange = sheet.getRange(startRow, columns.status, endRow - startRow + 1, 1);
  const originalStatuses = statusRange.getValues();
  const committedStatuses = originalStatuses.map(function(row) {
    return [row[0]];
  });
  const targetOffsets = {};

  updates.forEach(function(update) {
    const offset = update.row - startRow;
    const currentStatus = String(originalStatuses[offset][0] || "").trim().toLowerCase();
    if (currentStatus !== "pending") {
      throw new Error("Receipt status changed before final commit at row " + update.row + ".");
    }
    targetOffsets[offset] = true;
    committedStatuses[offset][0] = update.status;
  });

  statusRange.setValues(committedStatuses);
  return {
    startRow: startRow,
    endRow: endRow,
    originalStatuses: originalStatuses,
    targetOffsets: targetOffsets
  };
}

function verifyCommittedReceiptRows_(sheet, receiptUpdates, columns, transfersHeaderMap, statusCommit) {
  if (!statusCommit) return;
  const rowCount = statusCommit.endRow - statusCommit.startRow + 1;
  const rows = sheet.getRange(statusCommit.startRow, 1, rowCount, transfersHeaderMap.__lastColumn).getValues();

  (receiptUpdates || []).forEach(function(update) {
    const rowData = rows[update.row - statusCommit.startRow];
    const status = String(getCellByHeader_(rowData, transfersHeaderMap, "status") || "").trim().toLowerCase();
    if (status === "pending" || status !== update.status || !receiptRowMetadataMatches_(rowData, transfersHeaderMap, update)) {
      throw new Error("Committed receipt verification failed at row " + update.row + ".");
    }
  });

  rows.forEach(function(rowData, offset) {
    if (statusCommit.targetOffsets[offset]) return;
    if (rowData[columns.status - 1] !== statusCommit.originalStatuses[offset][0]) {
      throw new Error("Unrelated receipt status changed during final commit at row " + (statusCommit.startRow + offset) + ".");
    }
  });
}

function classifyReceiptCommitState_(sheet, receiptUpdates, transfersHeaderMap) {
  try {
    const readback = readReceiptRowsForVerification_(sheet, receiptUpdates, transfersHeaderMap);
    let allCommitted = true;
    let allPending = true;

    (receiptUpdates || []).forEach(function(update) {
      const rowData = readback.rows[update.row - readback.startRow];
      const status = String(getCellByHeader_(rowData, transfersHeaderMap, "status") || "").trim().toLowerCase();
      if (status !== "pending") allPending = false;
      if (status !== update.status || !receiptRowMetadataMatches_(rowData, transfersHeaderMap, update)) {
        allCommitted = false;
      }
    });

    if (allCommitted) return { state: "committed", message: "" };
    if (allPending) return { state: "pending", message: "" };
    return { state: "ambiguous", message: "Receipt rows are in a mixed or mismatched state." };
  } catch (error) {
    try {
      console.error("submitBranchReceipt reconciliation read failed", {
        message: error && error.message ? String(error.message) : String(error || "")
      });
    } catch (diagnosticError) {
      // Reconciliation classification must remain controlled even if diagnostics fail.
    }
    return { state: "ambiguous", message: "Receipt reconciliation read failed." };
  }
}

function buildReceiptPreCommitFailure_(message) {
  return {
    success: false,
    committed: false,
    ambiguous: false,
    message: String(message || "تعذر حفظ العملية حالياً. يرجى المحاولة مرة أخرى.")
  };
}

function buildReceiptAmbiguousResult_() {
  return {
    success: false,
    committed: false,
    ambiguous: true,
    message: "تعذر التأكد من نتيجة اعتماد الاستلام. لا تعِد إرسال العملية الآن. تم تحديث قائمة الشحنات للتحقق من الحالة."
  };
}

function getReceiptPostCommitWarning_() {
  return "تم اعتماد الاستلام وحفظه، لكن تعذر تحديث بعض سجلات المتابعة. لا تعِد إرسال العملية وراجع الإدارة عند استمرار المشكلة.";
}

function buildReceiptCommittedResult_(transferIds, hasWarning) {
  return {
    success: true,
    committed: true,
    ambiguous: false,
    warning: hasWarning ? getReceiptPostCommitWarning_() : "",
    transferIds: Array.isArray(transferIds) ? transferIds : []
  };
}

function reportReceiptPostCommitFailure_(logsSheet, user, context, error, now) {
  try {
    console.error("submitBranchReceipt optional post-commit work failed", {
      stage: String(context && context.stage ? context.stage : "unknown"),
      branchId: String(context && context.branchId ? context.branchId : ""),
      receiptRowCount: Number(context && context.receiptRowCount ? context.receiptRowCount : 0),
      message: error && error.message ? String(error.message) : String(error || "")
    });
  } catch (diagnosticError) {
    // A diagnostic failure must not change a committed receipt result.
  }
  try {
    logMovementSummaryFailure_(logsSheet, user, context, error, now);
  } catch (logError) {
    try {
      console.error("submitBranchReceipt post-commit diagnostic logging failed", {
        stage: String(context && context.stage ? context.stage : "unknown")
      });
    } catch (nestedDiagnosticError) {
      // A nested diagnostic failure must not escape.
    }
  }
}

function transferReceiptRowMatches_(rowData, transfersHeaderMap, receiptRef, employeeBranchId) {
  if (!rowData) return false;
  const rowTransferId = String(getCellByHeader_(rowData, transfersHeaderMap, "transfer_id") || "").trim();
  const rowBranchId = String(getCellByHeader_(rowData, transfersHeaderMap, "branch") || "").trim();
  const rowItemId = String(getCellByHeader_(rowData, transfersHeaderMap, "item_id") || "").trim();
  const rowStatus = String(getCellByHeader_(rowData, transfersHeaderMap, "status") || "").trim().toLowerCase();
  const rowQuantity = parseNumericInput_(getCellByHeader_(rowData, transfersHeaderMap, "quantity"));
  const rowUnit = String(getCellByHeader_(rowData, transfersHeaderMap, "unit") || "").trim();
  const rowNormalizedQty = parseNumericInput_(getCellByHeader_(rowData, transfersHeaderMap, "normalized_quantity"));

  return (
    rowStatus === "pending" &&
    rowBranchId === employeeBranchId &&
    String(receiptRef.branchId || "").trim() === employeeBranchId &&
    rowTransferId === String(receiptRef.transferId || "").trim() &&
    rowItemId === String(receiptRef.itemId || "").trim() &&
    Math.abs(parseNumericInput_(receiptRef.quantity) - rowQuantity) <= 0.000001 &&
    rowUnit === String(receiptRef.unit || "").trim() &&
    Math.abs(parseNumericInput_(receiptRef.normalizedQty) - rowNormalizedQty) <= 0.000001
  );
}

function readTransferRowByRowIndex_(transfersSheet, transfersHeaderMap, rowIndex) {
  const rowNumber = parseInt(rowIndex, 10);
  if (isNaN(rowNumber) || rowNumber < 2 || rowNumber > transfersSheet.getLastRow()) return null;
  return {
    rowNumber: rowNumber,
    row: transfersSheet.getRange(rowNumber, 1, 1, transfersHeaderMap.__lastColumn).getValues()[0]
  };
}

function findPendingTransferIndexRowForReceipt_(ss, receiptRef, employeeBranchId) {
  const indexSheet = getSheetByNameCaseInsensitive_(ss, "Pending_Transfer_Index");
  if (!indexSheet || indexSheet.getLastRow() < 2) return null;

  const headerMap = requireHeaderColumns_(indexSheet, getInventorySchemaRequirements_().Pending_Transfer_Index);
  const data = indexSheet.getRange(2, 1, indexSheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const targetTransferId = String(receiptRef.transferId || "").trim();
  const targetItemId = String(receiptRef.itemId || "").trim();
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const transferId = String(getCellByHeader_(row, headerMap, "transfer_id") || "").trim();
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    const receiptState = String(getCellByHeader_(row, headerMap, "receipt_state") || "").trim().toLowerCase();
    if (
      transferId === targetTransferId &&
      branchId === employeeBranchId &&
      itemId === targetItemId &&
      status === "pending" &&
      receiptState === "pending"
    ) {
      return {
        indexRowNumber: i + 2,
        transferRow: parseInt(getCellByHeader_(row, headerMap, "transfer_row"), 10) || 0
      };
    }
  }
  return null;
}

function resolveReceiptTransferRowForUpdate_(ss, transfersSheet, transfersHeaderMap, receiptRef, employeeBranchId) {
  const hinted = readTransferRowByRowIndex_(transfersSheet, transfersHeaderMap, receiptRef.rowIndex);
  if (hinted && transferReceiptRowMatches_(hinted.row, transfersHeaderMap, receiptRef, employeeBranchId)) {
    return hinted;
  }

  const indexMatch = findPendingTransferIndexRowForReceipt_(ss, receiptRef, employeeBranchId);
  if (indexMatch && indexMatch.transferRow) {
    const indexed = readTransferRowByRowIndex_(transfersSheet, transfersHeaderMap, indexMatch.transferRow);
    if (indexed && transferReceiptRowMatches_(indexed.row, transfersHeaderMap, receiptRef, employeeBranchId)) {
      return indexed;
    }
  }

  throw new Error("تعذر العثور على سطر الشحنة المعلقة. الرجاء تحديث الشاشة لأن الشحنة قد تكون عولجت أو تغيرت.");
}

function processBranchReceipt(receiptItems, sessionToken, mutationToken) {
  return submitBranchReceipt(receiptItems, sessionToken, mutationToken);
}

function submitBranchReceipt(receiptItems, sessionToken, mutationToken) {
  let lock = null;
  let lockAcquired = false;
  let receiptCommitStarted = false;
  let receiptCommitted = false;
  let commitVerificationCompleted = false;
  let receiptTransferIds = [];
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    lockAcquired = true;

    // Authorization may have changed while waiting for the lock.
    const lockedReceiptUser = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    if (
      String(lockedReceiptUser.employeeNumber || "") !== String(user.employeeNumber || "") ||
      String(lockedReceiptUser.branchId || "") !== String(user.branchId || "")
    ) {
      return buildReceiptPreCommitFailure_("تغيرت بيانات الجلسة. الرجاء تحديث الشاشة والمحاولة من جديد.");
    }
    requireActiveBranch_(ss, lockedReceiptUser.branchId);
    assertSubmissionBalancesReady_(ss);

    const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    const now = new Date();
    if (!transfersSheet) {
      return buildReceiptPreCommitFailure_("جدول Transfers غير موجود.");
    }
    if (!receiptItems || receiptItems.length === 0) {
      return buildReceiptPreCommitFailure_("لا توجد مواد استلام لمعالجتها.");
    }
    consumeMutationToken_(mutationToken, user.employeeNumber, "submit_branch_receipt");
    const employeeBranchId = user.branchId;
    if (!employeeBranchId) {
      return buildReceiptPreCommitFailure_("تعذر تحديد فرع الموظف لمعالجة الاستلام.");
    }
    requireActiveBranch_(ss, employeeBranchId);

    const lastRow = transfersSheet.getLastRow();
    if (lastRow < 2) {
      return buildReceiptPreCommitFailure_("لا توجد شحنات معلقة لمعالجتها.");
    }
    const transfersHeaderMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);
    const receiptColumns = {
      status: getHeaderIndex_(transfersHeaderMap, "status"),
      missingQty: getHeaderIndex_(transfersHeaderMap, "missing_qty"),
      note: getHeaderIndex_(transfersHeaderMap, "note"),
      receivedQuantity: getHeaderIndex_(transfersHeaderMap, "received_quantity"),
      receivedUnit: getHeaderIndex_(transfersHeaderMap, "received_unit"),
      receivedNormalizedQuantity: getHeaderIndex_(transfersHeaderMap, "received_normalized_quantity"),
      receivedAt: getHeaderIndex_(transfersHeaderMap, "received_at"),
      receivedBy: getHeaderIndex_(transfersHeaderMap, "received_by")
    };
    const catalog = getItemValidationCatalog_(ss);
    const seenRows = {};
    const receiptUpdates = [];
    const affectedTransferIds = {};

    receiptItems.forEach(function(item) {
      const receiptRef = resolveReceiptToken_(item.receiptToken);
      const resolvedRow = resolveReceiptTransferRowForUpdate_(ss, transfersSheet, transfersHeaderMap, receiptRef, employeeBranchId);
      const row = resolvedRow.rowNumber;
      if (seenRows[row]) {
        throw new Error("تم إرسال نفس سطر الاستلام أكثر من مرة. الرجاء تحديث الشاشة.");
      }
      seenRows[row] = true;

      const currentRow = resolvedRow.row;
      const rowTransferId = String(getCellByHeader_(currentRow, transfersHeaderMap, "transfer_id") || "").trim();
      const rowBranchId = String(getCellByHeader_(currentRow, transfersHeaderMap, "branch") || "").trim();
      const rowItemId = String(getCellByHeader_(currentRow, transfersHeaderMap, "item_id") || "").trim();
      const currentStatus = String(getCellByHeader_(currentRow, transfersHeaderMap, "status") || "").trim().toLowerCase();
      const rowOriginalQty = parseNumericInput_(getCellByHeader_(currentRow, transfersHeaderMap, "quantity"));
      const rowUnit = String(getCellByHeader_(currentRow, transfersHeaderMap, "unit") || "").trim();
      const rowNormalizedQty = parseNumericInput_(getCellByHeader_(currentRow, transfersHeaderMap, "normalized_quantity"));
      if (rowBranchId !== employeeBranchId) {
        throw new Error("لا يمكن اعتماد شحنة لا تخص فرع الموظف الحالي.");
      }
      if (currentStatus !== "pending") {
        throw new Error("لا يمكن تعديل شحنة تمت معالجتها مسبقاً.");
      }
      if (rowTransferId) affectedTransferIds[rowTransferId] = true;

      const originalQty = rowOriginalQty;
      const receivedQty = parseReceiptQuantityInput_(item.receivedQty);
      const receivedUnit = String(item.receivedUnit || rowUnit).trim();
      if (isNaN(originalQty)) {
        throw new Error("بيانات الاستلام غير صالحة في أحد الأسطر.");
      }
      if (!catalog[rowItemId] || !catalog[rowItemId].units.hasOwnProperty(receivedUnit)) {
        throw new Error("الوحدة المستلمة غير صالحة في أحد الأسطر.");
      }

      const receivedNormalizedQty = receivedQty * catalog[rowItemId].units[receivedUnit];
      const delta = receivedUnit === rowUnit ? originalQty - receivedQty : rowNormalizedQty - receivedNormalizedQty; // shortage + / surplus -
      const unitChanged = receivedUnit !== rowUnit;
      const hasReceiptDifference = unitChanged || delta !== 0;
      const finalStatus = hasReceiptDifference ? "missing" : "approved";
      const reason = String(item.reason || "").trim();
      const note = String(item.note || "").trim();

      if (hasReceiptDifference && !reason) {
        throw new Error("يجب تحديد سبب الفرق (نقص/زيادة) لكل سطر غير مطابق.");
      }

      const unitNote = receivedUnit === rowUnit ? "" : "الوحدة المستلمة: " + receivedUnit;
      const noteText = hasReceiptDifference ? [reason, unitNote, note].filter(Boolean).join(" - ") : [unitNote, note].filter(Boolean).join(" - ");
      receiptUpdates.push({
        row: row,
        transferId: rowTransferId,
        branchId: rowBranchId,
        itemId: rowItemId,
        status: finalStatus,
        missingQty: delta,
        note: noteText,
        receivedQuantity: receivedQty,
        receivedUnit: receivedUnit,
        receivedNormalizedQuantity: receivedNormalizedQty,
        receivedAt: now,
        receivedBy: user.employeeNumber
      });
    });
    receiptTransferIds = Object.keys(affectedTransferIds);

    bumpBalanceSourceVersion_();
    writeReceiptUpdates_(transfersSheet, receiptUpdates, receiptColumns);
    SpreadsheetApp.flush();
    verifyReceiptMetadata_(transfersSheet, receiptUpdates, transfersHeaderMap);

    let receiptHasPostCommitWarning = false;
    let receiptStatusCommit = null;
    receiptCommitStarted = true;
    try {
      receiptStatusCommit = commitReceiptStatuses_(transfersSheet, receiptUpdates, receiptColumns);
      SpreadsheetApp.flush();
    } catch (statusCommitError) {
      const reconciliation = classifyReceiptCommitState_(transfersSheet, receiptUpdates, transfersHeaderMap);
      if (reconciliation.state === "committed") {
        receiptCommitted = true;
        commitVerificationCompleted = true;
        receiptHasPostCommitWarning = true;
      } else if (reconciliation.state === "pending") {
        return buildReceiptPreCommitFailure_(getSafeWriteErrorMessage_(statusCommitError));
      } else {
        return buildReceiptAmbiguousResult_();
      }
    }

    if (!commitVerificationCompleted) {
      try {
        verifyCommittedReceiptRows_(transfersSheet, receiptUpdates, receiptColumns, transfersHeaderMap, receiptStatusCommit);
        receiptCommitted = true;
        commitVerificationCompleted = true;
      } catch (verificationError) {
        const reconciliation = classifyReceiptCommitState_(transfersSheet, receiptUpdates, transfersHeaderMap);
        if (reconciliation.state === "committed") {
          receiptCommitted = true;
          commitVerificationCompleted = true;
          receiptHasPostCommitWarning = true;
        } else if (reconciliation.state === "pending") {
          return buildReceiptPreCommitFailure_(getSafeWriteErrorMessage_(verificationError));
        } else {
          return buildReceiptAmbiguousResult_();
        }
      }
    }

    lockAcquired = false;
    lock.releaseLock();

    const updatedSummaryEntries = [];
    const updatedIndexEntries = [];
    let postCommitEntriesReady = true;
    try {
      receiptUpdates.forEach(function(update) {
        const rowData = transfersSheet.getRange(update.row, 1, 1, transfersHeaderMap.__lastColumn).getValues()[0];
        updatedSummaryEntries.push.apply(updatedSummaryEntries, buildTransferSummaryEntriesFromRow_(rowData, transfersHeaderMap, update.row, now, "received"));
        updatedIndexEntries.push(buildPendingTransferIndexEntryFromRow_(rowData, transfersHeaderMap, update.row, now));
      });
    } catch (entryBuildError) {
      postCommitEntriesReady = false;
      receiptHasPostCommitWarning = true;
      reportReceiptPostCommitFailure_(logsSheet, user, {
        stage: "entry_build",
        branchId: employeeBranchId,
        receiptRowCount: receiptUpdates.length
      }, entryBuildError, now);
    }

    if (postCommitEntriesReady) {
      try {
        upsertMovementDailySummaries_(ss, updatedSummaryEntries, { updatedAt: now });
      } catch (summaryError) {
        receiptHasPostCommitWarning = true;
        reportReceiptPostCommitFailure_(logsSheet, user, {
          stage: "movement_summary",
          branchId: employeeBranchId,
          receiptRowCount: receiptUpdates.length
        }, summaryError, now);
      }

      try {
        upsertPendingTransferIndexRows_(ss, updatedIndexEntries);
      } catch (indexError) {
        receiptHasPostCommitWarning = true;
        reportReceiptPostCommitFailure_(logsSheet, user, {
          stage: "pending_index",
          branchId: employeeBranchId,
          receiptRowCount: receiptUpdates.length
        }, indexError, now);
      }
    }

    try {
      const auditResult = tryLogCommittedAction_("BRANCH_RECEIVE_SUCCESS", "Employee " + user.employeeNumber + " processed receipt", {
        entityType: "receipt",
        employeeNumber: user.employeeNumber,
        branchId: employeeBranchId,
        receiptRowCount: receiptUpdates.length,
        transferIds: receiptTransferIds
      }, logsSheet, now);
      if (!auditResult || !auditResult.success) receiptHasPostCommitWarning = true;
    } catch (auditError) {
      receiptHasPostCommitWarning = true;
      reportReceiptPostCommitFailure_(logsSheet, user, {
        stage: "receipt_audit",
        branchId: employeeBranchId,
        receiptRowCount: receiptUpdates.length
      }, auditError, now);
    }

    return buildReceiptCommittedResult_(receiptTransferIds, receiptHasPostCommitWarning);
    
  } catch (e) {
    console.error("submitBranchReceipt failed", e);
    if (receiptCommitted && commitVerificationCompleted) {
      return buildReceiptCommittedResult_(receiptTransferIds, true);
    }
    if (receiptCommitStarted) {
      return buildReceiptAmbiguousResult_();
    }
    return buildReceiptPreCommitFailure_(getSafeWriteErrorMessage_(e));
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function getPurchaseBalanceCandidateRowNumbers_(sheet, headerMap, branchId) {
  const branchColumn = getHeaderIndex_(headerMap, "branch");
  return getExactTextMatchedRowNumbers_(sheet, branchColumn, branchId);
}

function getPurchaseMutationToken(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    return { success: true, token: createMutationToken_(user.employeeNumber, "submit_local_purchase", 600) };
  } catch (e) {
    console.error("getPurchaseMutationToken failed", e);
    return { success: false, message: "تعذر تجهيز الإرسال. لم نرسل طلبًا جديدًا؛ احتفظ بالطلب وحاول لاحقًا أو تواصل مع الإدارة." };
  }
}

function getTodayManagerPurchasesR01Read_(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    const branchId = String(user.branchId || "").trim();
    if (!branchId) {
      return { success: false, message: "تعذر تحديد فرع المدير الحالي." };
    }

    const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
    if (!purchasesSheet || purchasesSheet.getLastRow() < 2) {
      return { success: true, purchases: [], scannedRows: 0, totalRows: 0, scanLimited: false };
    }

    const headerMap = requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases);
    const recentRows = getRecentSheetRows_(purchasesSheet, headerMap, MANAGER_TODAY_PURCHASES_SCAN_LIMIT);
    const totalRows = Math.max(0, purchasesSheet.getLastRow() - 1);
    const dateRange = resolveOwnerReportDateRange_({});
    const itemsMap = getReferenceItems_(ss).byId || {};
    const suppliersMap = getReferenceSuppliers_(ss).byId || {};
    const purchases = [];

    for (let i = 0; i < recentRows.values.length; i++) {
      const row = recentRows.values[i];
      const rowBranchId = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
      if (rowBranchId !== branchId) continue;

      const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
      if (!createdAt || createdAt < dateRange.dateFromStart || createdAt >= dateRange.dateToExclusive) continue;

      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      const supplierId = String(getCellByHeader_(row, headerMap, "supplier") || "").trim();
      const item = itemsMap[itemId] || {};
      const supplier = suppliersMap[supplierId] || {};
      const supplierName = supplier.nameAr || supplierId || "مورد محلي";

      purchases.push({
        purchaseId: getCellByHeader_(row, headerMap, "purchase_id"),
        itemId: itemId,
        itemName: item.nameAr || "مادة غير معروفة",
        quantity: getCellByHeader_(row, headerMap, "quantity"),
        unit: getCellByHeader_(row, headerMap, "unit"),
        cost: getCellByHeader_(row, headerMap, "cost"),
        supplierId: supplierId,
        supplierName: supplierName,
        supplier: supplierName,
        createdAt: formatDateTimeForClient_(createdAt)
      });
    }

    purchases.reverse();
    return {
      success: true,
      purchases: purchases,
      scannedRows: recentRows.values.length,
      totalRows: totalRows,
      scanLimited: totalRows > recentRows.values.length
    };
  } catch (e) {
    console.error("getTodayManagerPurchases failed", e);
    return { success: false, message: "تعذر تحميل مشتريات اليوم حالياً. يمكنك متابعة تسجيل المشتريات والمحاولة لاحقاً." };
  }
}

function submitLocalPurchase(purchaseData, sessionToken, mutationToken, submissionId) {
  let lock = null;
  let lockAcquired = false;
  let businessWriteCommitted = false;
  let purchaseId = "";
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    requireInventorySubmissionId_(submissionId);
    ensureRuntimeSchemaReady_();
    lock = LockService.getScriptLock();
    // قفل السكريبت لمنع التداخل أثناء الحفظ المتزامن
    lock.waitLock(10000);
    lockAcquired = true;

    // Authorization may have changed while waiting for the lock.
    const lockedPurchaseUser = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    if (
      String(lockedPurchaseUser.employeeNumber || "") !== String(user.employeeNumber || "") ||
      String(lockedPurchaseUser.branchId || "") !== String(user.branchId || "")
    ) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "تغيرت بيانات الجلسة. الرجاء تحديث الشاشة والمحاولة من جديد.");
    }

    const existing = readInventorySubmission_(ss,user,'purchase',submissionId,purchaseData);
    if (existing) return reconcileInventorySubmission_(ss,existing);
    assertSubmissionBalancesReady_(ss);
    const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    const now = new Date();
    if (!purchasesSheet) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "جدول Purchases غير موجود.");
    }
    const purchasesHeaderMap = requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases);
    consumeMutationToken_(mutationToken, user.employeeNumber, "submit_local_purchase");
    const branchId = user.branchId;
    if (!branchId) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "تعذر تحديد فرع المدير الحالي.");
    }
    requireActiveBranch_(ss, branchId);

    const data = purchaseData || {};
    const supplierId = String(data.supplierId || "").trim();
    // Purchases.supplier stores the selected supplier ID, or "مورد محلي" when no listed supplier is selected.
    const supplierName = supplierId || "مورد محلي";
    const purchaseItems = Array.isArray(data.items) ? data.items : [data];
    const catalog = getItemValidationCatalog_(ss);

    if (supplierId && !isSupplierActive_(ss, supplierId)) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "المورد المحدد غير نشط أو غير موجود.");
    }
    if (!purchaseItems.length) {
      return inventorySubmissionResult_("NOT_SAVED", submissionId, "يجب إضافة مادة واحدة على الأقل قبل حفظ المشتريات.");
    }
    
    // توليد رقم معرف فريد للمشتريات (Purchase ID)
    purchaseId = "PUR-" + submissionId;

    let allowedLocalItems = null, allowedSupplierItems = null;
    const rowData = purchaseItems.map(function(rawItem) {
      const item = rawItem || {};
      const itemId = String(item.itemId || "").trim();
      const unit = String(item.unit || "").trim();
      const quantity = parseNumericInput_(item.quantity);
      const cost = parseCostInput_(item.cost, false);

      if (!itemId || !catalog[itemId]) {
        throw new Error("الصنف المحدد غير موجود في بيانات المنتجات.");
      }
      if (!unit || !catalog[itemId].units.hasOwnProperty(unit)) {
        throw new Error("الوحدة المحددة غير صالحة لهذا الصنف.");
      }
      if (!isFinite(quantity) || quantity <= 0) {
        throw new Error("يجب أن تكون الكمية المشتراة أكبر من الصفر.");
      }
      if (allowedLocalItems === null) allowedLocalItems = getAllowedItemIdsForBranch_(ss, branchId);
      if (!allowedLocalItems[itemId]) {
        throw new Error("هذا الصنف غير مصرح للشراء المحلي في هذا الفرع.");
      }
      if (supplierId) {
        if (allowedSupplierItems === null) allowedSupplierItems = (getReferenceSupplierItems_(ss).bySupplier || {})[supplierId] || {};
        if (allowedSupplierItems[itemId] !== true) throw new Error("هذا المورد غير مصرح له ببيع المادة المحددة.");
      }

      const normalizedQty = quantity * catalog[itemId].units[unit];
      if (!isFinite(normalizedQty)) throw new Error("Invalid normalized quantity");
      return buildRowByHeaders_(purchasesHeaderMap, {
        purchase_id: purchaseId,
        branch: branchId,
        supplier: supplierName,
        item_id: itemId,
        quantity: quantity,
        unit: unit,
        normalized_quantity: normalizedQty,
        cost: cost,
        created_by: user.employeeNumber,
        created_at: now
      });
    });

    const nextRow = purchasesSheet.getLastRow() + 1;
    const saved = saveInventorySubmission_(ss, user, 'purchase', submissionId, purchaseData, purchasesSheet, getInventorySchemaRequirements_().Purchases, rowData);
    if (!saved.committed) return saved;
    businessWriteCommitted = true;
    try {
      const summaryEntries = rowData.map(function(row, index) {
        return buildPurchaseSummaryEntryFromRow_(row, purchasesHeaderMap, nextRow + index, now);
      }).filter(function(entry) { return !!entry; });
      upsertMovementDailySummaries_(ss, summaryEntries, { updatedAt: now });
    } catch (summaryError) {
      console.error("submitLocalPurchase movement summary update failed", summaryError);
      logMovementSummaryFailure_(logsSheet, user, {
        flow: "submitLocalPurchase",
        purchaseId: purchaseId,
        branchId: branchId
      }, summaryError, now);
    }
    
    // تسجيل العملية في السجلات
    const auditResult = tryLogCommittedAction_("SUBMIT_LOCAL_PURCHASE", user.employeeNumber + " recorded purchase " + purchaseId, {
      entityId: purchaseId,
      entityType: "purchase",
      purchaseId: purchaseId,
      branchId: branchId,
      supplierId: supplierName,
      itemCount: rowData.length
    }, logsSheet, now);
    
    return {
      success: true,
      committed: businessWriteCommitted,
      outcome: "COMMITTED",
      submissionId: submissionId,
      warning: auditResult.warning,
      purchaseId: purchaseId,
      itemCount: rowData.length
    };
    
  } catch (e) {
    console.error("submitLocalPurchase failed", e);
    if (businessWriteCommitted) {
      return {
        success: true,
        committed: true,
        outcome: "COMMITTED",
        submissionId: submissionId,
        warning: "تم حفظ العملية، لكن تعذر إكمال تسجيلات ما بعد الحفظ حالياً. لا تعِد إرسال العملية.",
        purchaseId: purchaseId
      };
    }
    return inventorySubmissionFailure_(e, submissionId);
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

function getActiveSuppliersForUser_(ss, user) {
  const role = normalizeRole_(user && user.role);
  if (["manager", "owner"].indexOf(role) === -1) {
    throw new Error("ليست لديك صلاحية لتنفيذ هذه العملية.");
  }
  const refSuppliers = getReferenceSuppliers_(ss);
  if (!refSuppliers.sheetExists) {
    return { success: false, message: "جدول الموردين غير موجود." };
  }

  return { success: true, suppliers: refSuppliers.activeSuppliers || [] };
}

function getActiveSuppliers(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager", "owner"]);
    return getActiveSuppliersForUser_(ss, user);
  } catch (e) {
    console.error("getActiveSuppliers failed", { message: e && e.message ? e.message : String(e) });
    return { success: false, message: "تعذر تحميل الموردين. الرجاء تسجيل الدخول مجدداً." };
  }
}

function getSupplierAllowedItemsForBranch(supplierId, branchId, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    const supplierIdStr = String(supplierId || "").trim();
    const branchIdStr = String(branchId || "").trim();
    if (!supplierIdStr) {
      return { success: false, message: "الرجاء اختيار مورد صالح." };
    }
    if (!isSupplierActive_(ss, supplierIdStr)) {
      return { success: false, message: "المورد المحدد غير نشط أو غير موجود." };
    }
    if (!branchIdStr) {
      return { success: false, message: "تعذر تحديد الفرع الحالي." };
    }
    if (branchIdStr !== user.branchId) {
      return { success: false, message: "لا يمكن جلب مواد مورد لفرع آخر." };
    }
    requireActiveBranch_(ss, branchIdStr);

    const refSupplierItems = getReferenceSupplierItems_(ss);
    const refItems = getReferenceItems_(ss);
    if (!refSupplierItems.sheetExists) {
      return { success: false, message: "جدول مواد الموردين غير موجود." };
    }
    if (!refItems.sheetExists) {
      return { success: false, message: "جدول المواد غير موجود." };
    }

    const allowedForBranch = getAllowedItemIdsForBranch_(ss, branchIdStr);
    const supplierItemMap = (refSupplierItems.bySupplier || {})[supplierIdStr] || {};
    const items = [];
    (refItems.itemOrder || []).forEach(function(orderItem) {
      const itemId = String(orderItem.itemId || "").trim();
      const refItem = refItems.byId[itemId];
      const nameAr = refItem ? String(refItem.nameAr || "").trim() : "";
      if (itemId && nameAr && supplierItemMap[itemId] === true && allowedForBranch[itemId]) {
        items.push({
          itemId: itemId,
          nameAr: nameAr,
          sortOrder: refItem.sortOrder
        });
      }
    });

    sortItemsByCustomOrder_(items);
    return { success: true, items: items };
  } catch (e) {
    console.error("getSupplierAllowedItemsForBranch failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getAllowedLocalPurchaseItemsForUser_(ss, user) {
  try {
    const refItems = getReferenceItems_(ss);
    if (!refItems.sheetExists) {
      return { success: false, message: "جدول Items غير موجود." };
    }
    if (!user.branchId) {
      return { success: false, message: "تعذر تحديد فرع المدير الحالي." };
    }
    requireActiveBranch_(ss, user.branchId);
    const allowedItemIds = getAllowedItemIdsForBranch_(ss, user.branchId);

    const items = [];
    (refItems.itemOrder || []).forEach(function(orderItem) {
      const itemId = String(orderItem.itemId || "").trim();
      const refItem = refItems.byId[itemId];
      const nameAr = refItem ? String(refItem.nameAr || "").trim() : "";
      if (itemId && nameAr && allowedItemIds[itemId]) {
        items.push({
          itemId: itemId,
          nameAr: nameAr,
          sortOrder: refItem.sortOrder
        });
      }
    });
    sortItemsByCustomOrder_(items);
    return { success: true, items: items };
  } catch (e) {
    console.error("getAllowedLocalPurchaseItemsForUser_ failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getAllowedLocalPurchaseItems(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    return getAllowedLocalPurchaseItemsForUser_(ss, user);
  } catch (e) {
    console.error("getAllowedLocalPurchaseItems failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function getAllowedItemIdsForBranch_(ss, branchId) {
  const refAllowed = getReferenceAllowedLocalPurchases_(ss);
  return (refAllowed.byBranch || {})[String(branchId || "").trim()] || {};
}

function isItemAllowedForLocalPurchase_(ss, branchId, itemId) {
  const allowed = getAllowedItemIdsForBranch_(ss, branchId);
  return !!allowed[itemId];
}

function isSupplierActive_(ss, supplierId) {
  const supplierIdStr = String(supplierId || "").trim();
  if (!supplierIdStr) return false;

  const supplier = (getReferenceSuppliers_(ss).byId || {})[supplierIdStr];
  return !!(supplier && supplier.active);
}

function isItemAllowedForSupplier_(ss, supplierId, itemId) {
  const supplierIdStr = String(supplierId || "").trim();
  const itemIdStr = String(itemId || "").trim();
  if (!supplierIdStr || !itemIdStr) return false;

  const bySupplier = getReferenceSupplierItems_(ss).bySupplier || {};
  return !!(bySupplier[supplierIdStr] && bySupplier[supplierIdStr][itemIdStr] === true);
}

function getInventoryCountVisibilityMapForBranches_(ss, branchIds, periodMonth) {
  const result = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (id) result[id] = false;
  });

  const debugMap = getInventoryCountVisibilityDebugMapForBranches_(ss, branchIds, periodMonth);
  Object.keys(debugMap).forEach(function(branchId) {
    result[branchId] = debugMap[branchId].inventoryCountVisible === true;
  });
  return result;
}

function getInventoryControlEffectiveReason_(control) {
  if (!control) return "NO_CURRENT_PERIOD_ROW";
  if (control.visible !== true) return "VISIBLE_NOT_TRUE";
  if (control.status !== "open") return "STATUS_NOT_OPEN";
  return "VISIBLE_TRUE_STATUS_OPEN";
}

function getInventoryCountVisibilityDebugMapForBranches_(ss, branchIds, periodMonth) {
  const result = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (id) {
      result[id] = {
        inventoryCountVisible: false,
        inventoryControlRowNumberUsed: "",
        inventoryControlVisibleRaw: "",
        inventoryControlStatusRaw: "",
        inventoryControlPeriodRaw: "",
        inventoryControlFeatureKeyRaw: "",
        inventoryControlEffectiveReason: "NO_CURRENT_PERIOD_ROW"
      };
    }
  });

  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Control");
  if (!sheet || sheet.getLastRow() < 2) return result;

  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth || getCurrentInventoryPeriod_());
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Control);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const latestByBranch = {};
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (!result.hasOwnProperty(branchId)) continue;
    const rowPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "inventory_period"));
    const featureKey = normalizeInventoryFeatureKey_(getCellByHeader_(row, headerMap, "feature_key"));
    if (rowPeriod !== targetPeriod || featureKey !== "inventory_count") continue;
    latestByBranch[branchId] = chooseLatestInventoryControlRecord_(
      latestByBranch[branchId] || null,
      buildInventoryControlRecord_(row, headerMap, i + 2)
    );
  }
  Object.keys(latestByBranch).forEach(function(branchId) {
    const control = latestByBranch[branchId];
    result[branchId] = {
      inventoryCountVisible: control.isOpen === true,
      inventoryControlRowNumberUsed: control.rowNumber || "",
      inventoryControlVisibleRaw: control.visibleRaw,
      inventoryControlStatusRaw: control.statusRaw,
      inventoryControlPeriodRaw: control.inventoryPeriodRaw,
      inventoryControlFeatureKeyRaw: control.featureKeyRaw,
      inventoryControlEffectiveReason: getInventoryControlEffectiveReason_(control)
    };
  });
  return result;
}

function getInventoryControlRowSortTime_(row, headerMap) {
  const updatedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "updated_at"));
  if (updatedAt) return updatedAt.getTime();

  const timestampHeaders = ["opened_at", "closed_at", "submitted_at"];
  let latestTime = 0;
  timestampHeaders.forEach(function(headerName) {
    const parsed = parseSheetDate_(getCellByHeader_(row, headerMap, headerName));
    if (parsed && parsed.getTime() > latestTime) latestTime = parsed.getTime();
  });
  return latestTime;
}

function buildInventoryControlRecord_(row, headerMap, rowNumber) {
  const visibleRaw = getCellByHeader_(row, headerMap, "visible");
  const statusRaw = getCellByHeader_(row, headerMap, "status");
  const periodRaw = getCellByHeader_(row, headerMap, "inventory_period");
  const featureKeyRaw = getCellByHeader_(row, headerMap, "feature_key");
  const status = String(statusRaw || "").trim().toLowerCase();
  const visible = parseVisibilityBoolean_(visibleRaw);
  return {
    rowNumber: rowNumber,
    sortTime: getInventoryControlRowSortTime_(row, headerMap),
    branchId: String(getCellByHeader_(row, headerMap, "branch_id") || "").trim(),
    inventoryPeriod: normalizeInventoryPeriodValue_(periodRaw),
    inventoryPeriodRaw: periodRaw,
    featureKey: normalizeInventoryFeatureKey_(featureKeyRaw),
    featureKeyRaw: featureKeyRaw,
    visible: visible,
    visibleRaw: visibleRaw,
    status: status,
    statusRaw: statusRaw,
    isOpen: visible === true && status === "open",
    openedBy: getCellByHeader_(row, headerMap, "opened_by"),
    openedAt: getCellByHeader_(row, headerMap, "opened_at"),
    closedBy: getCellByHeader_(row, headerMap, "closed_by"),
    closedAt: getCellByHeader_(row, headerMap, "closed_at"),
    submittedBy: getCellByHeader_(row, headerMap, "submitted_by"),
    submittedAt: getCellByHeader_(row, headerMap, "submitted_at"),
    note: getCellByHeader_(row, headerMap, "note")
  };
}

function chooseLatestInventoryControlRecord_(current, candidate) {
  if (!current) return candidate;
  const currentTime = Number(current.sortTime || 0);
  const candidateTime = Number(candidate.sortTime || 0);
  if (candidateTime !== currentTime) return candidateTime > currentTime ? candidate : current;
  return Number(candidate.rowNumber || 0) > Number(current.rowNumber || 0) ? candidate : current;
}

function getInventoryControlForBranchPeriod_(ss, branchId, periodMonth, featureKey) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Control");
  if (!sheet) return null;
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth || getCurrentInventoryPeriod_());
  const targetFeatureKey = normalizeInventoryFeatureKey_(featureKey);
  if (!targetBranchId || !targetPeriod) return null;
  if (sheet.getLastRow() < 2) return null;

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Control);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  let latest = null;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const rowPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "inventory_period"));
    const rowFeatureKey = normalizeInventoryFeatureKey_(getCellByHeader_(row, headerMap, "feature_key"));
    if (rowBranchId === targetBranchId && rowPeriod === targetPeriod && rowFeatureKey === targetFeatureKey) {
      latest = chooseLatestInventoryControlRecord_(latest, buildInventoryControlRecord_(row, headerMap, i + 2));
    }
  }
  return latest;
}

function setInventoryControlVisibility_(ss, branchId, periodMonth, visible, ownerEmployeeNumber) {
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = String(periodMonth || getCurrentInventoryPeriod_()).trim();
  const featureKey = "inventory_count";
  requireActiveBranch_(ss, targetBranchId);
  if (!/^\d{4}-\d{2}$/.test(targetPeriod)) {
    throw new Error("صيغة شهر الجرد غير صحيحة.");
  }

  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Control");
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Control);
  const now = new Date();
  const existing = getInventoryControlForBranchPeriod_(ss, targetBranchId, targetPeriod, featureKey);
  const nextVisible = visible === true;
  const employeeNumber = String(ownerEmployeeNumber || "").trim();
  let status = nextVisible ? "open" : "hidden";

  if (existing) {
    if ((existing.status === "submitted" || existing.status === "locked") && nextVisible) {
      throw new Error("لا يمكن إعادة فتح جرد تم اعتماده لهذا الشهر.");
    }
    if (existing.status === "submitted" || existing.status === "locked") {
      return {
        success: true,
        writeMode: "unchanged_locked",
        rowNumber: existing.rowNumber,
        branchId: targetBranchId,
        inventoryPeriod: targetPeriod,
        featureKey: featureKey,
        visible: false,
        status: existing.status
      };
    }
    const dataRow = sheet.getRange(existing.rowNumber, 1, 1, headerMap.__lastColumn).getValues()[0];
    dataRow[getHeaderIndex_(headerMap, "visible") - 1] = nextVisible;
    dataRow[getHeaderIndex_(headerMap, "status") - 1] = status;
    if (nextVisible) {
      dataRow[getHeaderIndex_(headerMap, "opened_by") - 1] = employeeNumber;
      dataRow[getHeaderIndex_(headerMap, "opened_at") - 1] = now;
    } else {
      dataRow[getHeaderIndex_(headerMap, "closed_by") - 1] = employeeNumber;
      dataRow[getHeaderIndex_(headerMap, "closed_at") - 1] = now;
    }
    sheet.getRange(existing.rowNumber, 1, 1, headerMap.__lastColumn).setValues([dataRow]);
    return {
      success: true,
      writeMode: "updated",
      rowNumber: existing.rowNumber,
      branchId: targetBranchId,
      inventoryPeriod: targetPeriod,
      featureKey: featureKey,
      visible: nextVisible,
      status: status
    };
  }

  const newRow = buildRowByHeaders_(headerMap, {
    branch_id: targetBranchId,
    inventory_period: targetPeriod,
    feature_key: featureKey,
    visible: nextVisible,
    status: status,
    opened_by: nextVisible ? employeeNumber : "",
    opened_at: nextVisible ? now : "",
    closed_by: nextVisible ? "" : employeeNumber,
    closed_at: nextVisible ? "" : now
  });
  sheet.appendRow(newRow);
  return {
    success: true,
    writeMode: "appended",
    rowNumber: sheet.getLastRow(),
    branchId: targetBranchId,
    inventoryPeriod: targetPeriod,
    featureKey: featureKey,
    visible: nextVisible,
    status: status
  };
}

function isInventoryCountOpenForBranch_(ss, branchId, periodMonth) {
  const control = getInventoryControlForBranchPeriod_(ss, branchId, periodMonth, "inventory_count");
  return !!(control && control.visible === true && control.status === "open");
}

function getInventoryControlSubmissionTarget_(ss, branchId, periodMonth) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Control");
  if (!sheet || sheet.getLastRow() < 2) {
    return { control: null, matchingCount: 0, openCount: 0, ambiguous: false };
  }
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Control);
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const matches = [];
  let latest = null;
  let openCount = 0;

  rows.forEach(function(row, index) {
    const record = buildInventoryControlRecord_(row, headerMap, index + 2);
    if (
      record.branchId !== targetBranchId ||
      record.inventoryPeriod !== targetPeriod ||
      record.featureKey !== "inventory_count"
    ) {
      return;
    }
    matches.push(record);
    if (record.isOpen) openCount++;
    latest = chooseLatestInventoryControlRecord_(latest, record);
  });

  return {
    control: latest,
    matchingCount: matches.length,
    openCount: openCount,
    ambiguous: openCount > 1
  };
}

function markInventoryControlSubmitted_(ss, branchId, periodMonth, managerEmployeeNumber, expectedRowNumber) {
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth || getCurrentInventoryPeriod_());
  const target = getInventoryControlSubmissionTarget_(ss, targetBranchId, targetPeriod);
  if (target.ambiguous) {
    throw new Error("توجد أكثر من نافذة جرد فعالة لهذا الفرع والشهر. راجع الإدارة.");
  }
  const control = target.control;
  if (!control) {
    throw new Error("لا يوجد فتح جرد لهذا الفرع والشهر.");
  }
  const expectedRow = parseInt(expectedRowNumber, 10);
  if (!isNaN(expectedRow) && expectedRow > 1 && control.rowNumber !== expectedRow) {
    throw new Error("تغير سجل التحكم بالجرد أثناء الحفظ. راجع الإدارة.");
  }

  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Control");
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Control);
  const now = new Date();
  const employeeNumber = String(managerEmployeeNumber || "").trim();
  const dataRow = sheet.getRange(control.rowNumber, 1, 1, headerMap.__lastColumn).getValues()[0];
  const rowBranchId = String(getCellByHeader_(dataRow, headerMap, "branch_id") || "").trim();
  const rowPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(dataRow, headerMap, "inventory_period"));
  const rowFeatureKey = normalizeInventoryFeatureKey_(getCellByHeader_(dataRow, headerMap, "feature_key"));
  const rowStatus = String(getCellByHeader_(dataRow, headerMap, "status") || "").trim().toLowerCase();
  const rowVisible = parseVisibilityBoolean_(getCellByHeader_(dataRow, headerMap, "visible"));
  if (rowBranchId !== targetBranchId || rowPeriod !== targetPeriod || rowFeatureKey !== "inventory_count") {
    throw new Error("تغير سجل التحكم بالجرد أثناء الحفظ. راجع الإدارة.");
  }
  if ((rowStatus === "submitted" || rowStatus === "locked") && rowVisible !== true) {
    return {
      success: true,
      writeMode: "unchanged_submitted",
      rowNumber: control.rowNumber,
      branchId: targetBranchId,
      inventoryPeriod: targetPeriod,
      featureKey: "inventory_count",
      visible: false,
      status: rowStatus
    };
  }
  if (rowStatus !== "open" || rowVisible !== true) {
    throw new Error("فترة الجرد ليست مفتوحة لهذا الفرع والشهر.");
  }
  dataRow[getHeaderIndex_(headerMap, "visible") - 1] = false;
  dataRow[getHeaderIndex_(headerMap, "status") - 1] = "submitted";
  dataRow[getHeaderIndex_(headerMap, "submitted_by") - 1] = employeeNumber;
  dataRow[getHeaderIndex_(headerMap, "submitted_at") - 1] = now;
  dataRow[getHeaderIndex_(headerMap, "closed_by") - 1] = employeeNumber;
  dataRow[getHeaderIndex_(headerMap, "closed_at") - 1] = now;
  sheet.getRange(control.rowNumber, 1, 1, headerMap.__lastColumn).setValues([dataRow]);
  const readBack = sheet.getRange(control.rowNumber, 1, 1, headerMap.__lastColumn).getValues()[0];
  const readBackBranchId = String(getCellByHeader_(readBack, headerMap, "branch_id") || "").trim();
  const readBackPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(readBack, headerMap, "inventory_period"));
  const readBackStatus = String(getCellByHeader_(readBack, headerMap, "status") || "").trim().toLowerCase();
  const readBackVisible = parseVisibilityBoolean_(getCellByHeader_(readBack, headerMap, "visible"));
  if (
    readBackBranchId !== targetBranchId ||
    readBackPeriod !== targetPeriod ||
    readBackStatus !== "submitted" ||
    readBackVisible === true
  ) {
    throw new Error("تعذر تأكيد إغلاق فترة الجرد بعد اعتماد الجرد.");
  }
  return {
    success: true,
    writeMode: "updated",
    rowNumber: control.rowNumber,
    branchId: targetBranchId,
    inventoryPeriod: targetPeriod,
    featureKey: "inventory_count",
    visible: false,
    status: "submitted"
  };
}

function setFeatureVisibilityMirror_(ss, branchId, featureKey, visible, employeeNumber, now) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Feature_Visibility");
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Feature_Visibility);
  const data = sheet.getDataRange().getValues();
  const targetBranchId = String(branchId || "").trim();
  const targetFeatureKey = String(featureKey || "").trim();
  let rowIdx = -1;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const bId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const fKey = String(getCellByHeader_(row, headerMap, "feature_key") || "").trim();
    if (bId === targetBranchId && fKey === targetFeatureKey) {
      rowIdx = i + 1;
      break;
    }
  }

  if (rowIdx > 0) {
    const colVisible = getHeaderIndex_(headerMap, "visible");
    const colUpdatedBy = getHeaderIndex_(headerMap, "updated_by");
    const colUpdatedAt = getHeaderIndex_(headerMap, "updated_at");
    sheet.getRange(rowIdx, colVisible).setValue(visible);
    sheet.getRange(rowIdx, colUpdatedBy).setValue(employeeNumber);
    sheet.getRange(rowIdx, colUpdatedAt).setValue(now);
    return { writeMode: "updated", rowNumber: rowIdx };
  }

  const newRow = buildRowByHeaders_(headerMap, {
    branch_id: targetBranchId,
    feature_key: targetFeatureKey,
    visible: visible,
    updated_by: employeeNumber,
    updated_at: now
  });
  sheet.appendRow(newRow);
  return { writeMode: "appended", rowNumber: sheet.getLastRow() };
}

function getFeatureVisibility(branchId, sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const user = getAuthorizedUser_(ss, sessionToken, ["owner", "manager", "distributor"]);
  ensureRuntimeSchemaReady_();
  
  const targetBranchId = String(branchId || "").trim();
  if (user.role !== "owner" && user.branchId !== targetBranchId) {
    return { success: false, message: "ليست لديك صلاحية عرض إعدادات هذا الفرع.", visibility: { inventory_count: false, inventory_balance: true } };
  }

  const visibility = {
    inventory_count: isInventoryCountOpenForBranch_(ss, targetBranchId, getCurrentInventoryPeriod_()),
    inventory_balance: true
  };
  return { success: true, visibility: visibility };
}

function setFeatureVisibility(branchId, featureKey, visible, sessionToken) {
  let lock = null;
  let lockAcquired = false;
  const requestContext = {
    branchId: String(branchId || "").trim(),
    featureKey: String(featureKey || "").trim(),
    requestedVisible: visible === true,
    hasSessionToken: !!sessionToken
  };
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();
    lock = LockService.getScriptLock();
    lock.waitLock(10000);
    lockAcquired = true;
    
    const targetBranchId = String(branchId || "").trim();
    const targetBranch = requireActiveBranch_(ss, targetBranchId);
    
    if (featureKey === "inventory_balance") {
      return { success: false, message: "رصيد لا يتم التحكم به من إعدادات الفروع.", diagnosticCode: "FEATURE_INVALID" };
    }
    if (featureKey !== "inventory_count") {
      return { success: false, message: "مفتاح الخاصية غير صالح.", diagnosticCode: "FEATURE_INVALID" };
    }
    
    const now = new Date();
    const controlResult = setInventoryControlVisibility_(ss, targetBranchId, getCurrentInventoryPeriod_(), visible === true, user.employeeNumber);
    const mirrorResult = setFeatureVisibilityMirror_(ss, targetBranchId, featureKey, visible === true, user.employeeNumber, now);
    const controlReadBack = getInventoryControlForBranchPeriod_(ss, targetBranchId, controlResult ? controlResult.inventoryPeriod : getCurrentInventoryPeriod_(), featureKey);
    const readBackVisible = !!(controlReadBack && controlReadBack.visible === true && controlReadBack.status === "open");
    if (readBackVisible !== (visible === true)) {
      throw new Error("تعذر تأكيد حالة الجرد بعد الحفظ.");
    }
    
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    logActionDetail_("SET_FEATURE_VISIBILITY", user.employeeNumber + " set " + featureKey + " to " + visible + " for " + targetBranchId, {
      entityType: "feature_visibility",
      branchId: targetBranchId,
      periodMonth: featureKey === "inventory_count" && controlResult ? controlResult.inventoryPeriod : "",
      featureKey: featureKey,
      visible: visible === true,
      status: controlResult ? controlResult.status : "",
      employeeNumber: user.employeeNumber
    }, logsSheet, now);
    return {
      success: true,
      branchId: targetBranchId,
      branchName: targetBranch ? (targetBranch.name || targetBranch.nameAr || targetBranchId) : targetBranchId,
      featureKey: featureKey,
      visible: controlReadBack ? controlReadBack.visible === true : false,
      status: controlReadBack ? controlReadBack.status : "",
      inventoryPeriod: controlReadBack ? controlReadBack.inventoryPeriod : (controlResult ? controlResult.inventoryPeriod : getCurrentInventoryPeriod_()),
      inventoryControlWriteMode: controlResult ? (controlResult.writeMode || "") : "",
      inventoryControlRowNumber: controlResult ? (controlResult.rowNumber || "") : "",
      inventoryControlReadBackRowNumber: controlReadBack ? (controlReadBack.rowNumber || "") : "",
      inventoryControlReadBackVisibleRaw: controlReadBack ? controlReadBack.visibleRaw : "",
      inventoryControlReadBackStatusRaw: controlReadBack ? controlReadBack.statusRaw : "",
      mirrorWriteMode: mirrorResult ? (mirrorResult.writeMode || "") : "",
      mirrorRowNumber: mirrorResult ? (mirrorResult.rowNumber || "") : "",
      message: "تم حفظ الإعداد بنجاح."
    };
  } catch (e) {
    const errorMessage = e && e.message ? String(e.message) : String(e || "");
    let diagnosticCode = "WRITE_FAILED";
    if (/لا يمكن إعادة فتح|submitted|locked|اعتماده/i.test(errorMessage)) {
      diagnosticCode = "ALREADY_SUBMITTED_OR_LOCKED";
    } else if (/مفتاح الخاصية|feature/i.test(errorMessage)) {
      diagnosticCode = "FEATURE_INVALID";
    } else if (/lock/i.test(errorMessage)) {
      diagnosticCode = "LOCK_TIMEOUT";
    } else if (/session|token|صلاحية|انته/i.test(errorMessage)) {
      diagnosticCode = "SESSION_INVALID";
    } else if (/branch|فرع/i.test(errorMessage)) {
      diagnosticCode = "BRANCH_INVALID";
    } else if (/sheet|header|schema|column|ورقة|عمود/i.test(errorMessage)) {
      diagnosticCode = "SCHEMA_NOT_READY";
    }
    console.error("setFeatureVisibility failed", {
      branchId: requestContext.branchId,
      featureKey: requestContext.featureKey,
      requestedVisible: requestContext.requestedVisible,
      hasSessionToken: requestContext.hasSessionToken,
      diagnosticCode: diagnosticCode,
      message: errorMessage
    });
    return { success: false, message: "تعذر حفظ العملية حالياً. يرجى المحاولة مرة أخرى.", diagnosticCode: diagnosticCode };
  } finally {
    if (lockAcquired && lock) lock.releaseLock();
  }
}

function getManagerFeatureVisibility(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    return {
      success: true,
      visibility: {
        inventory_count: isInventoryCountOpenForBranch_(ss, user.branchId, getCurrentInventoryPeriod_()),
        inventory_balance: true
      }
    };
  } catch (e) {
    console.error("getManagerFeatureVisibility failed", {
      hasSessionToken: !!sessionToken,
      message: e && e.message ? String(e.message) : String(e || "")
    });
    return {
      success: false,
      visible: false,
      visibility: {
        inventory_count: false,
        inventory_balance: true
      },
      message: "تعذر التحقق من حالة الجرد حالياً. يمكنك متابعة العمليات الأخرى والمحاولة لاحقاً."
    };
  }
}


// ==================================================
// PHASE 6 — INVENTORY COUNTS / جرد
// ==================================================

function getInventoryCountMutationToken(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    return { success: true, token: createMutationToken_(user.employeeNumber, "submit_inventory_count", 1800) };
  } catch (e) {
    console.error("getInventoryCountMutationToken failed", e);
    return { success: false, message: "تعذر إنشاء رمز حماية العملية حالياً. يرجى تحديث الشاشة والمحاولة مرة أخرى." };
  }
}

function getInventoryPeriodFromInput_(periodInput) {
  const periodMonth = String(periodInput || getCurrentInventoryPeriod_()).trim();
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
    throw new Error("صيغة الشهر غير صحيحة.");
  }
  const month = Number(periodMonth.split("-")[1]);
  if (month < 1 || month > 12) {
    throw new Error("صيغة الشهر غير صحيحة.");
  }
  return periodMonth;
}

function getInventoryCountPeriodFromRow_(row, headerMap) {
  return normalizeInventoryPeriodValue_(
    getCellByHeader_(row, headerMap, "inventory_period") ||
    getCellByHeader_(row, headerMap, "period_month") ||
    ""
  );
}

function findFinalInventoryCountHeaders_(ss, branchId, periodMonth) {
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  if (!countsSheet || countsSheet.getLastRow() < 2) return [];
  const headerMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const data = countsSheet.getDataRange().getValues();
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const matches = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    if (!isFinalInventoryCountStatus_(status)) continue;
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const rowPeriod = getInventoryCountPeriodFromRow_(row, headerMap);
    const rowCountId = String(getCellByHeader_(row, headerMap, "count_id") || "").trim();
    const legacyItemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (!rowBranchId || rowBranchId !== targetBranchId || rowPeriod !== targetPeriod || !rowCountId) continue;
    if (legacyItemId) continue;

    const submittedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "submitted_at"));
    const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
    const timestamp = submittedAt ? submittedAt.getTime() : (createdAt ? createdAt.getTime() : 0);
    matches.push({
      rowNumber: i + 1,
      countId: rowCountId,
      status: status,
      timestamp: timestamp
    });
  }

  matches.sort(function(a, b) {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return b.rowNumber - a.rowNumber;
  });
  return matches;
}

function findSubmittedInventoryCountHeader_(ss, branchId, periodMonth) {
  const matches = findFinalInventoryCountHeaders_(ss, branchId, periodMonth);
  if (!matches.length) return null;
  return {
    rowNumber: matches[0].rowNumber,
    countId: matches[0].countId,
    status: matches[0].status
  };
}

function isFinalInventoryCountStatus_(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "submitted" || normalized === "locked";
}

function createInventoryCountHeader_(ss, branchId, periodMonth, managerEmployeeNumber, note) {
  const existing = findSubmittedInventoryCountHeader_(ss, branchId, periodMonth);
  if (existing) {
    throw new Error("تم اعتماد جرد لهذا الفرع في هذا الشهر مسبقاً.");
  }

  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  const headerMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const now = new Date();
  const employeeNumber = String(managerEmployeeNumber || "").trim();
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = String(periodMonth || "").trim();
  const countId = "CNT-" + targetBranchId + "-" + targetPeriod + "-" + now.getTime();
  const newRow = buildRowByHeaders_(headerMap, {
    count_id: countId,
    branch_id: targetBranchId,
    inventory_period: targetPeriod,
    period_month: targetPeriod,
    status: "draft_write_in_progress",
    note: String(note || "").trim(),
    created_by: employeeNumber,
    created_at: now,
    updated_at: now
  });
  countsSheet.appendRow(newRow);
  return { countId: countId, rowNumber: countsSheet.getLastRow(), submittedAt: now };
}

function updateInventoryCountHeaderStatus_(ss, rowNumber, status, employeeNumber, now, note) {
  const rowIdx = parseInt(rowNumber, 10);
  if (isNaN(rowIdx) || rowIdx < 2) return false;
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  if (!countsSheet) return false;

  const headerMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const dataRow = countsSheet.getRange(rowIdx, 1, 1, headerMap.__lastColumn).getValues()[0];
  const nextStatus = String(status || "").trim().toLowerCase();
  const updatedAt = now || new Date();
  const actor = String(employeeNumber || "").trim();

  dataRow[getHeaderIndex_(headerMap, "status") - 1] = nextStatus;
  dataRow[getHeaderIndex_(headerMap, "updated_at") - 1] = updatedAt;
  if (note !== undefined) {
    dataRow[getHeaderIndex_(headerMap, "note") - 1] = String(note || "").trim();
  }
  if (isFinalInventoryCountStatus_(nextStatus)) {
    dataRow[getHeaderIndex_(headerMap, "submitted_by") - 1] = actor;
    dataRow[getHeaderIndex_(headerMap, "submitted_at") - 1] = updatedAt;
    dataRow[getHeaderIndex_(headerMap, "locked_by") - 1] = actor;
    dataRow[getHeaderIndex_(headerMap, "locked_at") - 1] = updatedAt;
  } else {
    dataRow[getHeaderIndex_(headerMap, "submitted_by") - 1] = "";
    dataRow[getHeaderIndex_(headerMap, "submitted_at") - 1] = "";
    dataRow[getHeaderIndex_(headerMap, "locked_by") - 1] = "";
    dataRow[getHeaderIndex_(headerMap, "locked_at") - 1] = "";
  }
  countsSheet.getRange(rowIdx, 1, 1, headerMap.__lastColumn).setValues([dataRow]);
  return true;
}

function findIncompleteInventoryCountHeaders_(ss, branchId, periodMonth) {
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  if (!countsSheet || countsSheet.getLastRow() < 2) return [];
  const headerMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const rows = countsSheet.getRange(2, 1, countsSheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const matches = [];
  rows.forEach(function(row, index) {
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const rowPeriod = getInventoryCountPeriodFromRow_(row, headerMap);
    const countId = String(getCellByHeader_(row, headerMap, "count_id") || "").trim();
    const legacyItemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (
      rowBranchId === targetBranchId &&
      rowPeriod === targetPeriod &&
      countId &&
      !legacyItemId &&
      !isFinalInventoryCountStatus_(status)
    ) {
      matches.push({ rowNumber: index + 2, countId: countId, status: status });
    }
  });
  return matches;
}

function supersedeIncompleteInventoryCountDrafts_(ss, branchId, periodMonth, employeeNumber, now) {
  const drafts = findIncompleteInventoryCountHeaders_(ss, branchId, periodMonth);
  let updatedCount = 0;
  drafts.forEach(function(draft) {
    if (draft.status === "draft_superseded") return;
    if (updateInventoryCountHeaderStatus_(
      ss,
      draft.rowNumber,
      "draft_superseded",
      employeeNumber,
      now,
      "تم تجاوز مسودة غير مكتملة بمحاولة جرد لاحقة."
    )) {
      updatedCount++;
    }
  });
  return { foundCount: drafts.length, updatedCount: updatedCount };
}

function parseInventoryCountValidationNumber_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(normalizeDigits_(String(value)));
  return isFinite(parsed) ? parsed : null;
}

function validateInventoryCountRecord_(ss, countId, branchId, periodMonth, options) {
  const opts = options || {};
  const result = {
    valid: false,
    countId: String(countId || "").trim(),
    headerRowNumber: 0,
    status: "",
    itemCount: 0,
    errors: []
  };
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  const linesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Count_Lines");
  if (!result.countId || !targetBranchId || !targetPeriod || !countsSheet || !linesSheet) {
    result.errors.push("MISSING_REQUIRED_SOURCE");
    return result;
  }

  const countsHeaderMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const countRows = countsSheet.getLastRow() > 1
    ? countsSheet.getRange(2, 1, countsSheet.getLastRow() - 1, countsHeaderMap.__lastColumn).getValues()
    : [];
  const headerMatches = [];
  countRows.forEach(function(row, index) {
    const rowCountId = String(getCellByHeader_(row, countsHeaderMap, "count_id") || "").trim();
    const legacyItemId = String(getCellByHeader_(row, countsHeaderMap, "item_id") || "").trim();
    if (rowCountId === result.countId && !legacyItemId) {
      headerMatches.push({ row: row, rowNumber: index + 2 });
    }
  });
  if (headerMatches.length !== 1) {
    result.errors.push(headerMatches.length ? "DUPLICATE_HEADER" : "MISSING_HEADER");
    return result;
  }

  const header = headerMatches[0];
  result.headerRowNumber = header.rowNumber;
  result.status = String(getCellByHeader_(header.row, countsHeaderMap, "status") || "").trim().toLowerCase();
  const headerBranchId = String(getCellByHeader_(header.row, countsHeaderMap, "branch_id") || "").trim();
  const headerPeriod = getInventoryCountPeriodFromRow_(header.row, countsHeaderMap);
  const createdBy = String(getCellByHeader_(header.row, countsHeaderMap, "created_by") || "").trim();
  const createdAt = parseSheetDate_(getCellByHeader_(header.row, countsHeaderMap, "created_at"));
  if (headerBranchId !== targetBranchId) result.errors.push("HEADER_BRANCH_MISMATCH");
  if (headerPeriod !== targetPeriod) result.errors.push("HEADER_PERIOD_MISMATCH");
  if (!createdBy || !createdAt) result.errors.push("HEADER_IDENTIFIERS_INCOMPLETE");
  if (opts.requireFinal === true) {
    if (!isFinalInventoryCountStatus_(result.status)) result.errors.push("HEADER_NOT_FINAL");
    const submittedBy = String(getCellByHeader_(header.row, countsHeaderMap, "submitted_by") || "").trim();
    const submittedAt = parseSheetDate_(getCellByHeader_(header.row, countsHeaderMap, "submitted_at"));
    const lockedBy = String(getCellByHeader_(header.row, countsHeaderMap, "locked_by") || "").trim();
    const lockedAt = parseSheetDate_(getCellByHeader_(header.row, countsHeaderMap, "locked_at"));
    if (!submittedBy || !submittedAt || !lockedBy || !lockedAt) {
      result.errors.push("FINAL_IDENTIFIERS_INCOMPLETE");
    }
  } else if (isFinalInventoryCountStatus_(result.status)) {
    result.errors.push("DRAFT_ALREADY_FINAL");
  }

  const linesHeaderMap = requireHeaderColumns_(linesSheet, getInventorySchemaRequirements_().Inventory_Count_Lines);
  const lineRows = linesSheet.getLastRow() > 1
    ? linesSheet.getRange(2, 1, linesSheet.getLastRow() - 1, linesHeaderMap.__lastColumn).getValues()
    : [];
  const expectedByItem = {};
  (opts.expectedLines || []).forEach(function(line) {
    expectedByItem[String(line.itemId || "").trim()] = line;
  });
  const seenItems = {};
  lineRows.forEach(function(row) {
    const rowCountId = String(getCellByHeader_(row, linesHeaderMap, "count_id") || "").trim();
    if (rowCountId !== result.countId) return;
    result.itemCount++;
    const rowBranchId = String(getCellByHeader_(row, linesHeaderMap, "branch_id") || "").trim();
    const rowPeriod = getInventoryCountPeriodFromRow_(row, linesHeaderMap);
    const itemId = String(getCellByHeader_(row, linesHeaderMap, "item_id") || "").trim();
    const unit = String(getCellByHeader_(row, linesHeaderMap, "unit") || "").trim();
    const countQuantity = parseInventoryCountValidationNumber_(
      getCellByHeader_(row, linesHeaderMap, "count_quantity")
    );
    const normalizedQuantity = parseInventoryCountValidationNumber_(
      getCellByHeader_(row, linesHeaderMap, "normalized_quantity")
    );
    if (rowBranchId !== targetBranchId) result.errors.push("LINE_BRANCH_MISMATCH");
    if (rowPeriod !== targetPeriod) result.errors.push("LINE_PERIOD_MISMATCH");
    if (!itemId || !unit) result.errors.push("LINE_IDENTIFIERS_INCOMPLETE");
    if (seenItems[itemId]) result.errors.push("DUPLICATE_ITEM_LINE");
    seenItems[itemId] = true;
    if (countQuantity === null || countQuantity < 0) result.errors.push("INVALID_COUNT_QUANTITY");
    if (normalizedQuantity === null || normalizedQuantity < 0) result.errors.push("INVALID_NORMALIZED_QUANTITY");
    const expected = expectedByItem[itemId];
    if (opts.expectedLines && !expected) {
      result.errors.push("UNEXPECTED_ITEM_LINE");
    } else if (expected) {
      if (
        unit !== String(expected.unit || "").trim() ||
        countQuantity !== Number(expected.countQuantity) ||
        normalizedQuantity !== Number(expected.normalizedQuantity)
      ) {
        result.errors.push("LINE_PAYLOAD_MISMATCH");
      }
    }
  });

  if (result.itemCount < 1) result.errors.push("MISSING_COUNT_LINES");
  if (
    opts.expectedItemCount !== undefined &&
    result.itemCount !== Number(opts.expectedItemCount)
  ) {
    result.errors.push("ITEM_COUNT_MISMATCH");
  }
  result.valid = result.errors.length === 0;
  return result;
}

function validateTrustedInventoryCount_(ss, countId, branchId, periodMonth, options) {
  const opts = Object.assign({}, options || {}, { requireFinal: true });
  return validateInventoryCountRecord_(ss, countId, branchId, periodMonth, opts);
}

function appendInventoryCountLines_(ss, countId, branchId, periodMonth, validLines, now) {
  const lines = Array.isArray(validLines) ? validLines : [];
  if (!lines.length) {
    throw new Error("لا توجد أسطر جرد للحفظ.");
  }

  const linesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Count_Lines");
  const headerMap = requireHeaderColumns_(linesSheet, getInventorySchemaRequirements_().Inventory_Count_Lines);
  const targetBranchId = String(branchId || "").trim();
  const targetPeriod = String(periodMonth || "").trim();
  const createdAt = now || new Date();
  const rowsToAppend = lines.map(function(line) {
    return buildRowByHeaders_(headerMap, {
      count_id: countId,
      branch_id: targetBranchId,
      inventory_period: targetPeriod,
      period_month: targetPeriod,
      item_id: line.itemId,
      count_quantity: line.countQuantity,
      counted_quantity: line.countQuantity,
      unit: line.unit,
      normalized_quantity: line.normalizedQuantity,
      created_at: createdAt
    });
  });

  const startRow = Math.max(2, linesSheet.getLastRow() + 1);
  linesSheet.getRange(startRow, 1, rowsToAppend.length, headerMap.__lastColumn).setValues(rowsToAppend);
  return rowsToAppend.length;
}

function submitInventoryCount(counts, periodMonth, sessionToken, mutationToken) {
  let lock = null;
  let lockAcquired = false;
  let ss = null;
  let user = null;
  let headerResult = null;
  let countId = "";
  let normalizedPeriodMonth = "";
  let trustedCountCommitted = false;
  let controlClosed = false;
  let itemCount = 0;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();
    lock = LockService.getScriptLock();
    lock.waitLock(15000);
    lockAcquired = true;

    const lockedUser = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    if (
      String(lockedUser.employeeNumber || "") !== String(user.employeeNumber || "") ||
      String(lockedUser.branchId || "") !== String(user.branchId || "")
    ) {
      throw new Error("تغيرت بيانات الجلسة. الرجاء تحديث الشاشة والمحاولة من جديد.");
    }
    user = lockedUser;
    periodMonth = getInventoryPeriodFromInput_(periodMonth);
    normalizedPeriodMonth = periodMonth;
    const controlTarget = getInventoryControlSubmissionTarget_(ss, user.branchId, periodMonth);
    if (!controlTarget.control) {
      return { success: false, message: "لا يوجد فتح جرد لهذا الفرع والشهر." };
    }
    if (controlTarget.ambiguous) {
      console.error("submitInventoryCount ambiguous control rows", {
        branchId: user.branchId,
        periodMonth: periodMonth,
        openCount: controlTarget.openCount
      });
      return { success: false, message: "توجد أكثر من نافذة جرد فعالة لهذا الفرع والشهر. راجع الإدارة." };
    }
    const control = controlTarget.control;
    const controlIsClosed = control.status === "submitted" || control.status === "locked";
    if (controlIsClosed && control.visible === true) {
      return { success: false, message: "حالة فترة الجرد غير متسقة. راجع الإدارة." };
    }
    if (!control.isOpen && !controlIsClosed) {
      return { success: false, message: "خاصية الجرد غير مفعلة لهذا الفرع حالياً." };
    }

    consumeMutationToken_(mutationToken, user.employeeNumber, "submit_inventory_count");

    const existingFinalHeaders = findFinalInventoryCountHeaders_(ss, user.branchId, periodMonth);
    if (existingFinalHeaders.length > 1) {
      console.error("submitInventoryCount duplicate final count headers", {
        branchId: user.branchId,
        periodMonth: periodMonth,
        count: existingFinalHeaders.length
      });
      return { success: false, message: "يوجد أكثر من جرد نهائي لهذا الفرع والشهر. راجع الإدارة." };
    }
    if (existingFinalHeaders.length === 1) {
      countId = existingFinalHeaders[0].countId;
      const existingValidation = validateTrustedInventoryCount_(
        ss,
        countId,
        user.branchId,
        periodMonth
      );
      if (!existingValidation.valid) {
        console.error("submitInventoryCount existing final validation failed", {
          branchId: user.branchId,
          periodMonth: periodMonth,
          countId: countId,
          errors: existingValidation.errors
        });
        return { success: false, message: "الجرد النهائي الموجود يحتاج مراجعة الإدارة قبل إغلاق الفترة." };
      }
      trustedCountCommitted = true;
      itemCount = existingValidation.itemCount;
      let reconciliationWarning = "";
      if (control.isOpen) {
        markInventoryControlSubmitted_(
          ss,
          user.branchId,
          periodMonth,
          user.employeeNumber,
          control.rowNumber
        );
        controlClosed = true;
        const reconciliationAudit = tryLogCommittedAction_(
          "RECONCILE_INVENTORY_COUNT_CONTROL",
          user.employeeNumber + " reconciled count control for " + periodMonth,
          {
            entityType: "inventory_count",
            entityId: countId,
            countId: countId,
            branchId: user.branchId,
            periodMonth: periodMonth,
            itemCount: itemCount,
            reconciled: true
          },
          getSheetByNameCaseInsensitive_(ss, "Logs"),
          new Date()
        );
        reconciliationWarning = reconciliationAudit.warning;
      } else {
        controlClosed = true;
      }
      return {
        success: true,
        committed: true,
        reconciled: true,
        alreadySubmitted: true,
        countId: countId,
        itemCount: itemCount,
        warning: reconciliationWarning,
        message: "تم تأكيد الجرد المعتمد وإغلاق فترة الجرد."
      };
    }
    if (!control.isOpen) {
      return {
        success: false,
        message: "فترة الجرد مغلقة لكن لا يوجد جرد نهائي موثوق. راجع الإدارة."
      };
    }
    if (!Array.isArray(counts) || counts.length === 0) {
      return { success: false, message: "الرجاء إدخال كمية لمادة واحدة على الأقل." };
    }
    
    const now = new Date();
    const validLines = [];
    const seenItemIds = {};
    const catalog = getItemValidationCatalog_(ss);
    
    for (let i = 0; i < counts.length; i++) {
      const c = counts[i];
      if (!c.itemId || c.countedQuantity === undefined || c.countedQuantity === null || String(c.countedQuantity).trim() === "" || !c.unit) {
        return { success: false, message: "بيانات الجرد غير مكتملة." };
      }
      
      if (!catalog[c.itemId]) {
        console.error("submitInventoryCount invalid item", {
          branchId: user.branchId,
          periodMonth: periodMonth,
          itemId: String(c.itemId || "").trim(),
          rowIndex: i
        });
        return { success: false, message: "توجد مادة غير صالحة في بيانات الجرد. الرجاء تحديث الصفحة والمحاولة مرة أخرى." };
      }
      if (seenItemIds[c.itemId]) {
        return { success: false, message: "تم إدخال المادة نفسها أكثر من مرة في الجرد." };
      }
      seenItemIds[c.itemId] = true;
      
      if (!catalog[c.itemId].units || !catalog[c.itemId].units.hasOwnProperty(c.unit)) {
        console.error("submitInventoryCount invalid unit", {
          branchId: user.branchId,
          periodMonth: periodMonth,
          itemId: String(c.itemId || "").trim(),
          unit: String(c.unit || "").trim(),
          rowIndex: i
        });
        return { success: false, message: "توجد وحدة غير صالحة في بيانات الجرد. الرجاء تحديث الصفحة والمحاولة مرة أخرى." };
      }
      const qty = parseFloat(normalizeDigits_(String(c.countedQuantity)));
      if (isNaN(qty) || qty < 0) {
        return { success: false, message: "كمية غير صالحة في بيانات الجرد." };
      }
      
      const normQty = qty * catalog[c.itemId].units[c.unit];
      validLines.push({
        itemId: c.itemId,
        countQuantity: qty,
        unit: c.unit,
        normalizedQuantity: normQty
      });
    }

    bumpBalanceSourceVersion_();
    supersedeIncompleteInventoryCountDrafts_(
      ss,
      user.branchId,
      periodMonth,
      user.employeeNumber,
      now
    );
    headerResult = createInventoryCountHeader_(ss, user.branchId, periodMonth, user.employeeNumber, "");
    countId = headerResult.countId;
    itemCount = appendInventoryCountLines_(ss, countId, user.branchId, periodMonth, validLines, now);
    const draftValidation = validateInventoryCountRecord_(ss, countId, user.branchId, periodMonth, {
      requireFinal: false,
      expectedItemCount: validLines.length,
      expectedLines: validLines
    });
    if (!draftValidation.valid) {
      throw new Error("تعذر التحقق من اكتمال مسودة الجرد.");
    }
    if (!updateInventoryCountHeaderStatus_(
      ss,
      headerResult.rowNumber,
      "submitted",
      user.employeeNumber,
      now,
      ""
    )) {
      throw new Error("تعذر اعتماد رأس الجرد.");
    }
    const trustedValidation = validateTrustedInventoryCount_(
      ss,
      countId,
      user.branchId,
      periodMonth,
      {
        expectedItemCount: validLines.length,
        expectedLines: validLines
      }
    );
    if (!trustedValidation.valid) {
      throw new Error("تعذر التحقق من الجرد النهائي بعد الاعتماد.");
    }
    trustedCountCommitted = true;
    const controlResult = markInventoryControlSubmitted_(
      ss,
      user.branchId,
      periodMonth,
      user.employeeNumber,
      control.rowNumber
    );
    controlClosed = true;
    
    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    const auditResult = tryLogCommittedAction_(
      "SUBMIT_INVENTORY_COUNT",
      user.employeeNumber + " submitted count for " + periodMonth,
      {
      entityType: "inventory_count",
      entityId: countId,
      countId: countId,
      branchId: user.branchId,
      periodMonth: periodMonth,
      submittedBy: user.employeeNumber,
      itemCount: itemCount,
      status: controlResult.status,
      reconciled: false
      },
      logsSheet,
      now
    );
    
    return {
      success: true,
      committed: true,
      reconciled: false,
      alreadySubmitted: false,
      countId: countId,
      itemCount: itemCount,
      warning: auditResult.warning,
      message: "تم اعتماد الجرد بنجاح."
    };
  } catch (e) {
    if (trustedCountCommitted) {
      console.error("submitInventoryCount post-commit step failed", {
        countId: countId,
        branchId: user && user.branchId ? user.branchId : "",
        periodMonth: normalizedPeriodMonth,
        message: e && e.message ? String(e.message) : String(e || "")
      });
      return {
        success: true,
        committed: true,
        reconciled: false,
        alreadySubmitted: true,
        countId: countId,
        itemCount: itemCount,
        warning: controlClosed
          ? "تم حفظ الجرد واعتماده، لكن تعذر تسجيل خطوة لاحقة. لا تعِد إرسال الجرد، وراجع الإدارة."
          : "تم حفظ الجرد واعتماده، لكن تعذر إغلاق فترة الجرد تلقائياً. لا تعِد إرسال الجرد، وراجع الإدارة.",
        message: "تم حفظ الجرد واعتماده."
      };
    }
    if (!trustedCountCommitted && ss && headerResult && headerResult.rowNumber) {
      try {
        updateInventoryCountHeaderStatus_(
          ss,
          headerResult.rowNumber,
          "draft_write_failed",
          user && user.employeeNumber ? user.employeeNumber : "",
          new Date(),
          "فشل حفظ الجرد بالكامل. لا يعتمد هذا الصف."
        );
      } catch (markError) {
        console.error("submitInventoryCount failed to mark header incomplete", {
          countId: countId,
          periodMonth: normalizedPeriodMonth,
          message: markError && markError.message ? markError.message : String(markError)
        });
      }
    }
    console.error("submitInventoryCount failed", e);
    return { success: false, message: "تعذر حفظ العملية حالياً. يرجى المحاولة مرة أخرى." };
  } finally {
    if (lockAcquired && lock) lock.releaseLock();
  }
}

function getLatestBalanceSnapshotMetadataByBranch_(ss, branchIds) {
  const result = {};
  const branchFilter = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (id) {
      branchFilter[id] = true;
      result[id] = {
        latestBalanceCalculatedAt: "",
        latestBalanceRunId: "",
        latestBalanceStatus: "",
        latestBalanceMessage: ""
      };
    }
  });

  const runMap = getSuccessfulBalanceRunMap_(ss);

  // Try reading from Inventory_Balance_Current first
  const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
  const hasCurrentSheet = currentSheet && currentSheet.getLastRow() > 1;
  const currentHeaderMap = hasCurrentSheet ? requireHeaderColumns_(currentSheet, getInventorySchemaRequirements_().Inventory_Balance_Current) : null;
  const currentData = hasCurrentSheet ? currentSheet.getRange(2, 1, currentSheet.getLastRow() - 1, currentHeaderMap.__lastColumn).getValues() : [];
  const historicalRunIndex = hasCurrentSheet ? getHistoricalBalanceRunGroupIndex_(ss) : { byRunBranchPeriod: {} };

  const branchesFoundInCurrent = {};

  if (hasCurrentSheet && currentData.length > 0) {
    const currentGroupsByBranch = {};
    for (let i = 0; i < currentData.length; i++) {
      const row = currentData[i];
      const branchId = String(getCellByHeader_(row, currentHeaderMap, "branch_id") || "").trim();
      if (!branchFilter[branchId]) continue;

      const runId = String(getCellByHeader_(row, currentHeaderMap, "run_id") || "").trim();
      const periodMonth = String(getCellByHeader_(row, currentHeaderMap, "period_month") || "").trim();
      const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, runId, branchId, periodMonth);
      if (!runMeta) continue;
      const groupKey = getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth);

      const calculatedAt = parseSheetDate_(getCellByHeader_(row, currentHeaderMap, "calculated_at"));
      const calcTime = calculatedAt ? calculatedAt.getTime() : 0;

      if (!currentGroupsByBranch[branchId]) currentGroupsByBranch[branchId] = {};
      if (!currentGroupsByBranch[branchId][groupKey]) {
        currentGroupsByBranch[branchId][groupKey] = {
          runId: runId,
          branchId: branchId,
          periodMonth: periodMonth,
          runMeta: runMeta,
          rows: [],
          headerMap: currentHeaderMap,
          calculatedAt: null,
          maxCalcTime: 0,
          maxDataIndex: i + 2
        };
      }
      const group = currentGroupsByBranch[branchId][groupKey];
      group.rows.push(row);
      if (calcTime >= group.maxCalcTime) {
        group.maxCalcTime = calcTime;
        group.calculatedAt = calculatedAt;
      }
      if (i + 2 > group.maxDataIndex) group.maxDataIndex = i + 2;
    }

    Object.keys(currentGroupsByBranch).forEach(function(branchId) {
      const groupList = Object.keys(currentGroupsByBranch[branchId]).map(function(key) {
        return currentGroupsByBranch[branchId][key];
      });
      groupList.sort(function(a, b) {
        const aSort = a.runMeta ? a.runMeta.sortTime : a.maxCalcTime;
        const bSort = b.runMeta ? b.runMeta.sortTime : b.maxCalcTime;
        if (aSort !== bSort) return bSort - aSort;
        if (a.periodMonth !== b.periodMonth) return a.periodMonth < b.periodMonth ? 1 : -1;
        if (a.maxCalcTime !== b.maxCalcTime) return b.maxCalcTime - a.maxCalcTime;
        return b.maxDataIndex - a.maxDataIndex;
      });
      for (let j = 0; j < groupList.length; j++) {
        const group = groupList[j];
        if (isCompleteCurrentBalanceGroup_(group, historicalRunIndex, group.runMeta)) {
          branchesFoundInCurrent[branchId] = {
            runId: group.runId,
            runMeta: group.runMeta,
            calculatedAt: group.calculatedAt,
            calcTime: group.maxCalcTime
          };
          break;
        }
      }
    });
  }

  // Populate branches found in current
  Object.keys(branchesFoundInCurrent).forEach(function(branchId) {
    const meta = branchesFoundInCurrent[branchId];
    const runMeta = meta.runMeta || null;
    result[branchId] = {
      latestBalanceCalculatedAt: meta.calculatedAt ? formatBalanceSnapshotDateTime_(meta.calculatedAt) : "",
      latestBalanceRunId: meta.runId || "",
      latestBalanceStatus: runMeta ? (runMeta.status || "success") : "success",
      latestBalanceMessage: runMeta ? (runMeta.message || "") : ""
    };
  });

  // For any branch NOT found in current, fallback to reading from Inventory_Balances
  const fallbackBranchIds = (branchIds || []).filter(function(branchId) {
    return branchId && !branchesFoundInCurrent[branchId];
  });

  if (fallbackBranchIds.length > 0) {
    const fallbackFilter = {};
    fallbackBranchIds.forEach(function(id) { fallbackFilter[id] = true; });

    const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
    if (sheet && sheet.getLastRow() > 1) {
      const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balances);
      const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();

      const runGroupsByBranch = {};

      function ensureGroup_(collection, branchId, key, defaults) {
        if (!collection[branchId]) collection[branchId] = {};
        if (!collection[branchId][key]) collection[branchId][key] = defaults;
        return collection[branchId][key];
      }

      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
        if (!fallbackFilter[branchId]) continue;

        const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
        const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
        const calculatedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
        const calcTime = calculatedAt ? calculatedAt.getTime() : 0;

        if (runId) {
          const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, runId, branchId, periodMonth);
          if (!runMeta) continue;
          const group = ensureGroup_(runGroupsByBranch, branchId, runId + "|" + periodMonth, {
            runId: runId,
            runMeta: runMeta,
            periodMonth: periodMonth,
            rows: [],
            itemIds: {},
            malformed: false,
            calculatedAt: null,
            maxCalcTime: 0,
            maxDataIndex: i + 2
          });
          const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
          if (!itemId || group.itemIds[itemId]) {
            group.malformed = true;
          }
          group.itemIds[itemId] = true;
          group.rows.push(row);
          if (calcTime >= group.maxCalcTime) {
            group.maxCalcTime = calcTime;
            group.calculatedAt = calculatedAt;
          }
          if (i + 2 > group.maxDataIndex) group.maxDataIndex = i + 2;
        }
      }

      fallbackBranchIds.forEach(function(branchId) {
        const runGroups = Object.keys(runGroupsByBranch[branchId] || {}).map(function(runId) {
          return runGroupsByBranch[branchId][runId];
        });
        if (runGroups.length) {
          runGroups.sort(function(a, b) {
            const aSort = a.runMeta ? a.runMeta.sortTime : a.maxCalcTime;
            const bSort = b.runMeta ? b.runMeta.sortTime : b.maxCalcTime;
            if (aSort !== bSort) return bSort - aSort;
            if (a.maxCalcTime !== b.maxCalcTime) return b.maxCalcTime - a.maxCalcTime;
            return b.maxDataIndex - a.maxDataIndex;
          });
          let latest = null;
          for (let j = 0; j < runGroups.length; j++) {
            const group = runGroups[j];
            const expectedItems = Number(group.runMeta && group.runMeta.itemsProcessed || 0);
            if (!group.malformed && group.rows && group.rows.length > 0 && (!expectedItems || group.rows.length === expectedItems)) {
              latest = group;
              break;
            }
          }
          if (!latest) return;
          result[branchId] = {
            latestBalanceCalculatedAt: latest.calculatedAt ? formatBalanceSnapshotDateTime_(latest.calculatedAt) : "",
            latestBalanceRunId: latest.runId || "",
            latestBalanceStatus: latest.runMeta ? (latest.runMeta.status || "success") : "success",
            latestBalanceMessage: latest.runMeta ? (latest.runMeta.message || "") : ""
          };
          return;
        }
      });
    }
  }

  return result;
}

function getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth) {
  return String(runId || "").trim() + "|" + String(branchId || "").trim() + "|" + String(periodMonth || "").trim();
}

function isSuccessfulBalanceRunStatus_(status) {
  return String(status || "").trim().toLowerCase() === "success";
}

function buildSuccessfulBalanceRunMapFromRows_(rows, headerMap, sourceStartRow) {
  const result = { hasRunLogRows: false, byRunBranchPeriod: {}, runsByIdForDiagnostics: {} };
  if (!headerMap || !getHeaderIndex_(headerMap, "run_id") || !getHeaderIndex_(headerMap, "status")) {
    return result;
  }

  const startRow = parseInt(sourceStartRow, 10) || 2;
  const data = rows || [];
  result.hasRunLogRows = data.length > 0;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    if (!runId) continue;
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();

    const finishedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "finished_at"));
    const startedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "started_at"));
    const sortTime = finishedAt ? finishedAt.getTime() : (startedAt ? startedAt.getTime() : 0);
    const runMeta = {
      runId: runId,
      triggerType: String(getCellByHeader_(row, headerMap, "trigger_type") || "").trim(),
      status: status,
      periodMonth: periodMonth,
      branchId: branchId,
      periodStart: getCellByHeader_(row, headerMap, "period_start"),
      periodEnd: getCellByHeader_(row, headerMap, "period_end"),
      startedAt: startedAt,
      finishedAt: finishedAt,
      itemsProcessed: Number(getCellByHeader_(row, headerMap, "items_processed") || 0),
      message: String(getCellByHeader_(row, headerMap, "message") || "").trim(),
      sortTime: sortTime,
      rowIndex: startRow + i
    };

    if (!result.runsByIdForDiagnostics[runId]) result.runsByIdForDiagnostics[runId] = [];
    result.runsByIdForDiagnostics[runId].push(runMeta);

    if (!isSuccessfulBalanceRunStatus_(status)) continue;
    if (!branchId || !periodMonth) continue;
    const exactKey = getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth);
    const existingExact = result.byRunBranchPeriod[exactKey];
    if (!existingExact || sortTime > existingExact.sortTime || (sortTime === existingExact.sortTime && runMeta.rowIndex > existingExact.rowIndex)) {
      result.byRunBranchPeriod[exactKey] = runMeta;
    }
  }

  return result;
}

function buildHistoricalBalanceRunGroupIndexFromRows_(rows, headerMap) {
  const result = { byRunBranchPeriod: {} };
  if (!headerMap) return result;

  const data = rows || [];
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (!runId || !branchId || !periodMonth || !itemId) continue;

    const key = getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth);
    if (!result.byRunBranchPeriod[key]) {
      result.byRunBranchPeriod[key] = {
        runId: runId,
        branchId: branchId,
        periodMonth: periodMonth,
        rows: [],
        itemIds: {},
        duplicateItemIds: {},
        malformed: false
      };
    }

    const group = result.byRunBranchPeriod[key];
    group.rows.push(row);
    if (group.itemIds[itemId]) {
      group.duplicateItemIds[itemId] = true;
      group.malformed = true;
    }
    group.itemIds[itemId] = true;
  }

  return result;
}

function getHistoricalBalanceRunGroupIndex_(ss) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  if (!sheet || sheet.getLastRow() < 2) return { byRunBranchPeriod: {} };

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balances);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  return buildHistoricalBalanceRunGroupIndexFromRows_(data, headerMap);
}

function getRecentHistoricalBalanceRunGroupIndex_(ss, limit) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  if (!sheet || sheet.getLastRow() < 2) return { byRunBranchPeriod: {} };

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balances);
  const recentRows = getRecentSheetRows_(sheet, headerMap, limit || BALANCE_HISTORICAL_RECENT_SCAN_LIMIT);
  return buildHistoricalBalanceRunGroupIndexFromRows_(recentRows.values, headerMap);
}

function isCompleteCurrentBalanceGroup_(currentGroup, historicalRunIndex, runMeta) {
  if (!currentGroup || !historicalRunIndex || !runMeta) return false;
  const runId = String(currentGroup.runId || "").trim();
  const branchId = String(currentGroup.branchId || "").trim();
  const periodMonth = String(currentGroup.periodMonth || "").trim();
  if (!runId || !branchId || !periodMonth) return false;
  if (String(runMeta.runId || "").trim() !== runId) return false;
  if (String(runMeta.branchId || "").trim() !== branchId) return false;
  if (String(runMeta.periodMonth || "").trim() !== periodMonth) return false;
  if (!isSuccessfulBalanceRunStatus_(runMeta.status)) return false;

  const historicalGroup = historicalRunIndex.byRunBranchPeriod[getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth)];
  if (!historicalGroup || historicalGroup.malformed || !historicalGroup.rows || historicalGroup.rows.length === 0) return false;

  const rows = currentGroup.rows || [];
  const currentHeaderMap = currentGroup.headerMap;
  if (!currentHeaderMap || rows.length === 0 || rows.length !== historicalGroup.rows.length) return false;
  const expectedItems = Number(runMeta.itemsProcessed || 0);
  if (expectedItems > 0 && (rows.length !== expectedItems || historicalGroup.rows.length !== expectedItems)) return false;

  const currentItemIds = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowRunId = String(getCellByHeader_(row, currentHeaderMap, "run_id") || "").trim();
    const rowBranchId = String(getCellByHeader_(row, currentHeaderMap, "branch_id") || "").trim();
    const rowPeriodMonth = String(getCellByHeader_(row, currentHeaderMap, "period_month") || "").trim();
    const itemId = String(getCellByHeader_(row, currentHeaderMap, "item_id") || "").trim();
    if (!rowRunId || !rowBranchId || !rowPeriodMonth || !itemId) return false;
    if (rowRunId !== runId || rowBranchId !== branchId || rowPeriodMonth !== periodMonth) return false;
    if (currentItemIds[itemId]) return false;
    currentItemIds[itemId] = true;
  }

  const historicalItemIds = historicalGroup.itemIds || {};
  const expectedItemIds = Object.keys(historicalItemIds);
  if (Object.keys(currentItemIds).length !== expectedItemIds.length) return false;
  for (let j = 0; j < expectedItemIds.length; j++) {
    if (!currentItemIds[expectedItemIds[j]]) return false;
  }

  return true;
}

function buildTrustedCurrentBalanceSnapshotFromRows_(rows, headerMap, targetBranchId, runMap, historicalRunIndex) {
  const groups = {};
  const targetId = String(targetBranchId || "").trim();

  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (rowBranchId !== targetId) continue;

    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    const calcAtDate = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
    const calcTime = calcAtDate ? calcAtDate.getTime() : 0;
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, runId, targetId, periodMonth);
    if (!runMeta) continue;
    const groupKey = getBalanceRunBranchPeriodKey_(runId, targetId, periodMonth);

    if (!groups[groupKey]) {
      groups[groupKey] = {
        periodMonth: periodMonth,
        branchId: targetId,
        rows: [],
        headerMap: headerMap,
        maxCalcTime: 0,
        maxDataIndex: i,
        calculatedAt: null,
        runId: runId,
        runMeta: runMeta
      };
    }
    const group = groups[groupKey];
    group.rows.push(row);
    if (calcTime >= group.maxCalcTime) {
      group.maxCalcTime = calcTime;
      group.calculatedAt = calcAtDate;
    }
    if (i > group.maxDataIndex) group.maxDataIndex = i;
  }

  const groupList = Object.keys(groups).map(function(groupKey) {
    return groups[groupKey];
  });
  if (!groupList.length) return null;

  groupList.sort(function(a, b) {
    const aSort = a.runMeta ? a.runMeta.sortTime : a.maxCalcTime;
    const bSort = b.runMeta ? b.runMeta.sortTime : b.maxCalcTime;
    if (aSort !== bSort) return bSort - aSort;
    if (a.periodMonth !== b.periodMonth) return a.periodMonth < b.periodMonth ? 1 : -1;
    if (a.maxCalcTime !== b.maxCalcTime) return b.maxCalcTime - a.maxCalcTime;
    return b.maxDataIndex - a.maxDataIndex;
  });

  for (let j = 0; j < groupList.length; j++) {
    const group = groupList[j];
    if (isCompleteCurrentBalanceGroup_(group, historicalRunIndex, group.runMeta)) {
      return {
        success: true,
        rows: group.rows,
        headerMap: headerMap,
        sourceSheetName: "Inventory_Balance_Current",
        periodMonth: group.periodMonth,
        calculatedAt: group.calculatedAt,
        runId: group.runId,
        warning: "",
        message: ""
      };
    }
  }

  return null;
}

function getBalanceLatestIndexSheetName_() {
  return "Inventory_Balance_Latest_Index";
}

function getBalanceLatestIndexHeaders_() {
  return [
    "branch_id",
    "period_month",
    "run_id",
    "calculated_at",
    "current_start_row",
    "current_row_count",
    "historical_start_row",
    "historical_row_count",
    "run_log_row",
    "expected_item_count",
    "status",
    "updated_at"
  ];
}

function logRejectedBalanceLatestIndex_(branchId, reason) {
  try {
    console.warn("Balance latest index rejected", {
      branchId: String(branchId || "").trim(),
      reason: String(reason || "invalid_index_entry").trim()
    });
  } catch (e) {
    // Diagnostics must not change the saved-balance result.
  }
}

function parsePositiveBalanceIndexInteger_(value) {
  const parsed = Number(value);
  return isFinite(parsed) && parsed > 0 && Math.floor(parsed) === parsed ? parsed : 0;
}

function buildBalanceLatestIndexEntryFromRow_(row, headerMap, sourceRow) {
  return {
    branchId: String(getCellByHeader_(row, headerMap, "branch_id") || "").trim(),
    periodMonth: String(getCellByHeader_(row, headerMap, "period_month") || "").trim(),
    runId: String(getCellByHeader_(row, headerMap, "run_id") || "").trim(),
    calculatedAt: getCellByHeader_(row, headerMap, "calculated_at"),
    currentStartRow: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "current_start_row")),
    currentRowCount: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "current_row_count")),
    historicalStartRow: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "historical_start_row")),
    historicalRowCount: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "historical_row_count")),
    runLogRow: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "run_log_row")),
    expectedItemCount: parsePositiveBalanceIndexInteger_(getCellByHeader_(row, headerMap, "expected_item_count")),
    status: String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase(),
    updatedAt: getCellByHeader_(row, headerMap, "updated_at"),
    sourceRow: sourceRow
  };
}

function validateExactBalanceIndexRangeRows_(rows, headerMap, entry) {
  const result = { valid: false, itemIds: {}, reason: "" };
  if (!entry || !headerMap || !rows || rows.length !== entry.expectedItemCount) {
    result.reason = "wrong_expected_item_count";
    return result;
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (runId !== entry.runId || branchId !== entry.branchId || periodMonth !== entry.periodMonth) {
      result.reason = "range_run_branch_period_mismatch";
      return result;
    }
    if (!itemId || result.itemIds[itemId]) {
      result.reason = "duplicate_or_missing_item";
      return result;
    }
    result.itemIds[itemId] = true;
  }
  result.valid = true;
  return result;
}

function getTrustedBalanceSnapshotFromLatestIndex_(ss, branchId) {
  const targetBranchId = String(branchId || "").trim();
  if (!targetBranchId) return null;
  const indexSheet = getSheetByNameCaseInsensitive_(ss, getBalanceLatestIndexSheetName_());
  if (!indexSheet || indexSheet.getLastRow() < 2) return null;

  try {
    const indexHeaderMap = requireHeaderColumns_(indexSheet, getBalanceLatestIndexHeaders_());
    const indexRows = indexSheet.getRange(2, 1, indexSheet.getLastRow() - 1, indexHeaderMap.__lastColumn).getValues();
    const matches = [];
    for (let i = 0; i < indexRows.length; i++) {
      if (String(getCellByHeader_(indexRows[i], indexHeaderMap, "branch_id") || "").trim() === targetBranchId) {
        matches.push(buildBalanceLatestIndexEntryFromRow_(indexRows[i], indexHeaderMap, i + 2));
      }
    }
    if (matches.length !== 1) {
      logRejectedBalanceLatestIndex_(targetBranchId, matches.length ? "duplicate_branch_entries" : "missing_branch_entry");
      return null;
    }

    const entry = matches[0];
    if (
      entry.branchId !== targetBranchId ||
      !entry.periodMonth ||
      !entry.runId ||
      !isSuccessfulBalanceRunStatus_(entry.status) ||
      !entry.currentStartRow ||
      !entry.currentRowCount ||
      !entry.historicalStartRow ||
      !entry.historicalRowCount ||
      !entry.runLogRow ||
      !entry.expectedItemCount ||
      entry.currentRowCount !== entry.expectedItemCount ||
      entry.historicalRowCount !== entry.expectedItemCount
    ) {
      logRejectedBalanceLatestIndex_(targetBranchId, "invalid_required_index_fields");
      return null;
    }

    const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
    const historicalSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
    const runLogSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
    if (!currentSheet || !historicalSheet || !runLogSheet) {
      logRejectedBalanceLatestIndex_(targetBranchId, "indexed_source_sheet_missing");
      return null;
    }
    if (
      entry.currentStartRow + entry.currentRowCount - 1 > currentSheet.getLastRow() ||
      entry.historicalStartRow + entry.historicalRowCount - 1 > historicalSheet.getLastRow() ||
      entry.runLogRow > runLogSheet.getLastRow()
    ) {
      logRejectedBalanceLatestIndex_(targetBranchId, "stale_physical_row_pointer");
      return null;
    }

    const currentHeaderMap = requireHeaderColumns_(currentSheet, getInventorySchemaRequirements_().Inventory_Balance_Current);
    const historicalHeaderMap = requireHeaderColumns_(historicalSheet, getInventorySchemaRequirements_().Inventory_Balances);
    const runLogHeaderMap = requireHeaderColumns_(runLogSheet, getInventorySchemaRequirements_().Inventory_Balance_Run_Log);
    const runLogRows = runLogSheet.getRange(entry.runLogRow, 1, 1, runLogHeaderMap.__lastColumn).getValues();
    const runMap = buildSuccessfulBalanceRunMapFromRows_(runLogRows, runLogHeaderMap, entry.runLogRow);
    const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, entry.runId, entry.branchId, entry.periodMonth);
    if (
      !runMeta ||
      runMeta.rowIndex !== entry.runLogRow ||
      !isSuccessfulBalanceRunStatus_(runMeta.status) ||
      (Number(runMeta.itemsProcessed || 0) > 0 && Number(runMeta.itemsProcessed) !== entry.expectedItemCount)
    ) {
      logRejectedBalanceLatestIndex_(targetBranchId, "exact_success_run_log_rejected");
      return null;
    }

    const currentRows = currentSheet.getRange(
      entry.currentStartRow,
      1,
      entry.currentRowCount,
      currentHeaderMap.__lastColumn
    ).getValues();
    const historicalRows = historicalSheet.getRange(
      entry.historicalStartRow,
      1,
      entry.historicalRowCount,
      historicalHeaderMap.__lastColumn
    ).getValues();
    const currentValidation = validateExactBalanceIndexRangeRows_(currentRows, currentHeaderMap, entry);
    const historicalValidation = validateExactBalanceIndexRangeRows_(historicalRows, historicalHeaderMap, entry);
    if (!currentValidation.valid || !historicalValidation.valid) {
      logRejectedBalanceLatestIndex_(targetBranchId, currentValidation.reason || historicalValidation.reason);
      return null;
    }
    const currentItemIds = Object.keys(currentValidation.itemIds).sort();
    const historicalItemIds = Object.keys(historicalValidation.itemIds).sort();
    if (currentItemIds.join("|") !== historicalItemIds.join("|")) {
      logRejectedBalanceLatestIndex_(targetBranchId, "current_historical_item_set_mismatch");
      return null;
    }

    const historicalRunIndex = buildHistoricalBalanceRunGroupIndexFromRows_(historicalRows, historicalHeaderMap);
    const snapshot = buildTrustedCurrentBalanceSnapshotFromRows_(
      currentRows,
      currentHeaderMap,
      targetBranchId,
      runMap,
      historicalRunIndex
    );
    if (
      !snapshot ||
      snapshot.runId !== entry.runId ||
      snapshot.periodMonth !== entry.periodMonth ||
      !snapshot.rows ||
      snapshot.rows.length !== entry.expectedItemCount
    ) {
      logRejectedBalanceLatestIndex_(targetBranchId, "trusted_snapshot_validation_failed");
      return null;
    }
    snapshot.sourceSheetName = "Inventory_Balance_Current";
    snapshot.headerMap = currentHeaderMap;
    snapshot.indexed = true;
    return snapshot;
  } catch (e) {
    logRejectedBalanceLatestIndex_(targetBranchId, "index_read_exception");
    return null;
  }
}

function buildContiguousBalanceBranchSegments_(rows, headerMap, sourceStartRow) {
  const segments = {};
  const closed = {};
  let previousBranchId = "";
  for (let i = 0; i < (rows || []).length; i++) {
    const branchId = String(getCellByHeader_(rows[i], headerMap, "branch_id") || "").trim();
    if (!branchId) throw new Error("Balance index segment has a missing branch ID.");
    if (branchId !== previousBranchId) {
      if (closed[branchId]) throw new Error("Balance rows for a branch are not contiguous.");
      if (previousBranchId) closed[previousBranchId] = true;
      segments[branchId] = { startRow: Number(sourceStartRow) + i, rowCount: 0 };
      previousBranchId = branchId;
    }
    segments[branchId].rowCount++;
  }
  return segments;
}

function buildBalanceLatestIndexRow_(headerMap, entry) {
  return buildRowByHeaders_(headerMap, {
    branch_id: entry.branchId,
    period_month: entry.periodMonth,
    run_id: entry.runId,
    calculated_at: entry.calculatedAt,
    current_start_row: entry.currentStartRow,
    current_row_count: entry.currentRowCount,
    historical_start_row: entry.historicalStartRow,
    historical_row_count: entry.historicalRowCount,
    run_log_row: entry.runLogRow,
    expected_item_count: entry.expectedItemCount,
    status: "success",
    updated_at: entry.updatedAt || new Date()
  });
}

function upsertBalanceLatestIndexEntries_(ss, entries) {
  const indexSheet = getSheetByNameCaseInsensitive_(ss, getBalanceLatestIndexSheetName_());
  if (!indexSheet) return { success: true, skipped: true, updated: 0 };
  const headerMap = requireHeaderColumns_(indexSheet, getBalanceLatestIndexHeaders_());
  const existingRows = indexSheet.getLastRow() > 1
    ? indexSheet.getRange(2, 1, indexSheet.getLastRow() - 1, headerMap.__lastColumn).getValues()
    : [];
  const rowByBranch = {};
  for (let i = 0; i < existingRows.length; i++) {
    const branchId = String(getCellByHeader_(existingRows[i], headerMap, "branch_id") || "").trim();
    if (!branchId) continue;
    if (rowByBranch[branchId] !== undefined) throw new Error("Duplicate branch rows exist in the balance latest index.");
    rowByBranch[branchId] = i;
  }
  (entries || []).forEach(function(entry) {
    const branchId = String(entry && entry.branchId || "").trim();
    if (!branchId) throw new Error("Balance latest index entry is missing branch ID.");
    const row = buildBalanceLatestIndexRow_(headerMap, entry);
    if (rowByBranch[branchId] === undefined) {
      rowByBranch[branchId] = existingRows.length;
      existingRows.push(row);
    } else {
      existingRows[rowByBranch[branchId]] = row;
    }
  });
  if (existingRows.length) {
    indexSheet.getRange(2, 1, existingRows.length, headerMap.__lastColumn).setValues(existingRows);
  }
  return { success: true, skipped: false, updated: (entries || []).length };
}

function tryUpsertBalanceLatestIndexEntries_(ss, entries) {
  try {
    return upsertBalanceLatestIndexEntries_(ss, entries);
  } catch (e) {
    console.error("Optional balance latest index update failed", {
      message: e && e.message ? e.message : String(e)
    });
    return { success: false, skipped: false, updated: 0 };
  }
}

function buildPhysicalBalanceRunGroupsFromRows_(rows, headerMap, sourceStartRow) {
  const groups = {};
  const startRow = Number(sourceStartRow || 2);
  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (!runId || !branchId || !periodMonth || !itemId) continue;
    const key = getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth);
    if (!groups[key]) {
      groups[key] = {
        key: key,
        runId: runId,
        branchId: branchId,
        periodMonth: periodMonth,
        rows: [],
        headerMap: headerMap,
        itemIds: {},
        duplicateItemIds: {},
        malformed: false,
        contiguous: true,
        startRow: startRow + i,
        endRow: startRow + i,
        calculatedAt: null,
        maxCalcTime: 0
      };
    }
    const group = groups[key];
    const physicalRow = startRow + i;
    if (group.rows.length && physicalRow !== group.endRow + 1) group.contiguous = false;
    group.endRow = physicalRow;
    group.rows.push(row);
    if (group.itemIds[itemId]) {
      group.duplicateItemIds[itemId] = true;
      group.malformed = true;
    }
    group.itemIds[itemId] = true;
    const calculatedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
    const calcTime = calculatedAt ? calculatedAt.getTime() : 0;
    if (calcTime >= group.maxCalcTime) {
      group.maxCalcTime = calcTime;
      group.calculatedAt = calculatedAt;
    }
  }
  return groups;
}

function setupAndBackfillBalanceLatestIndex_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = getBalanceLatestIndexSheetName_();
  let indexSheet = getSheetByNameCaseInsensitive_(ss, sheetName);
  let created = false;
  if (!indexSheet) {
    indexSheet = ss.insertSheet(sheetName);
    created = true;
  }
  if (indexSheet.getLastRow() < 1 || indexSheet.getLastColumn() < 1) {
    indexSheet.getRange(1, 1, 1, getBalanceLatestIndexHeaders_().length).setValues([getBalanceLatestIndexHeaders_()]);
  }
  requireHeaderColumns_(indexSheet, getBalanceLatestIndexHeaders_());

  const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
  const historicalSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  const runLogSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
  if (!currentSheet || !historicalSheet || !runLogSheet) {
    throw new Error("Balance source sheets are missing; latest index backfill was not performed.");
  }
  const currentHeaderMap = requireHeaderColumns_(currentSheet, getInventorySchemaRequirements_().Inventory_Balance_Current);
  const historicalHeaderMap = requireHeaderColumns_(historicalSheet, getInventorySchemaRequirements_().Inventory_Balances);
  const runLogHeaderMap = requireHeaderColumns_(runLogSheet, getInventorySchemaRequirements_().Inventory_Balance_Run_Log);
  const currentRows = currentSheet.getLastRow() > 1
    ? currentSheet.getRange(2, 1, currentSheet.getLastRow() - 1, currentHeaderMap.__lastColumn).getValues()
    : [];
  const historicalRows = historicalSheet.getLastRow() > 1
    ? historicalSheet.getRange(2, 1, historicalSheet.getLastRow() - 1, historicalHeaderMap.__lastColumn).getValues()
    : [];
  const runLogRows = runLogSheet.getLastRow() > 1
    ? runLogSheet.getRange(2, 1, runLogSheet.getLastRow() - 1, runLogHeaderMap.__lastColumn).getValues()
    : [];
  const runMap = buildSuccessfulBalanceRunMapFromRows_(runLogRows, runLogHeaderMap, 2);
  const currentGroups = buildPhysicalBalanceRunGroupsFromRows_(currentRows, currentHeaderMap, 2);
  const historicalGroups = buildPhysicalBalanceRunGroupsFromRows_(historicalRows, historicalHeaderMap, 2);
  const historicalRunIndex = { byRunBranchPeriod: historicalGroups };
  const activeBranchIds = getActiveBalanceBranchIds_(ss);
  const entries = [];
  const skipped = [];
  const ambiguous = [];

  activeBranchIds.forEach(function(branchId) {
    const candidates = [];
    Object.keys(currentGroups).forEach(function(key) {
      const currentGroup = currentGroups[key];
      if (currentGroup.branchId !== branchId || !currentGroup.contiguous) return;
      const historicalGroup = historicalGroups[key];
      if (!historicalGroup || !historicalGroup.contiguous) return;
      const runMeta = getSuccessfulBalanceRunForBranchPeriod_(
        runMap,
        currentGroup.runId,
        branchId,
        currentGroup.periodMonth
      );
      if (!runMeta || !isCompleteCurrentBalanceGroup_(currentGroup, historicalRunIndex, runMeta)) return;
      const expectedItemCount = currentGroup.rows.length;
      if (
        !expectedItemCount ||
        historicalGroup.rows.length !== expectedItemCount ||
        (Number(runMeta.itemsProcessed || 0) > 0 && Number(runMeta.itemsProcessed) !== expectedItemCount)
      ) return;
      candidates.push({
        key: key,
        sortTime: Number(runMeta.sortTime || currentGroup.maxCalcTime || 0),
        entry: {
          branchId: branchId,
          periodMonth: currentGroup.periodMonth,
          runId: currentGroup.runId,
          calculatedAt: currentGroup.calculatedAt,
          currentStartRow: currentGroup.startRow,
          currentRowCount: expectedItemCount,
          historicalStartRow: historicalGroup.startRow,
          historicalRowCount: expectedItemCount,
          runLogRow: runMeta.rowIndex,
          expectedItemCount: expectedItemCount,
          updatedAt: new Date()
        }
      });
    });
    candidates.sort(function(a, b) { return b.sortTime - a.sortTime; });
    if (!candidates.length) {
      skipped.push(branchId);
      return;
    }
    if (candidates.length > 1 && candidates[0].sortTime === candidates[1].sortTime && candidates[0].key !== candidates[1].key) {
      ambiguous.push(branchId);
      return;
    }
    entries.push(candidates[0].entry);
  });

  upsertBalanceLatestIndexEntries_(ss, entries);
  const verified = [];
  const verificationFailed = [];
  entries.forEach(function(entry) {
    const snapshot = getTrustedBalanceSnapshotFromLatestIndex_(ss, entry.branchId);
    if (
      snapshot &&
      snapshot.runId === entry.runId &&
      snapshot.periodMonth === entry.periodMonth &&
      snapshot.rows &&
      snapshot.rows.length === entry.expectedItemCount
    ) {
      verified.push(entry.branchId);
    } else {
      verificationFailed.push(entry.branchId);
    }
  });
  return {
    success: verificationFailed.length === 0,
    sheetCreated: created,
    indexed: verified,
    skipped: skipped,
    ambiguous: ambiguous,
    verificationFailed: verificationFailed,
    currentRowCount: currentRows.length,
    historicalRowCount: historicalRows.length,
    runLogRowCount: runLogRows.length
  };
}

function getCurrentBalanceSnapshotForBranchFast_(ss, branchId) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
  if (!sheet || sheet.getLastRow() < 2) return null;

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balance_Current);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  if (!data.length) return null;

  const runMap = getSuccessfulBalanceRunMap_(ss);
  const historicalRunIndex = getHistoricalBalanceRunGroupIndex_(ss);
  return buildTrustedCurrentBalanceSnapshotFromRows_(data, headerMap, branchId, runMap, historicalRunIndex);
}

function getCurrentBalanceSnapshotForBranch_(ss, branchId) {
  const indexedSnapshot = getTrustedBalanceSnapshotFromLatestIndex_(ss, branchId);
  if (indexedSnapshot) return indexedSnapshot;

  const fastSnapshot = getCurrentBalanceSnapshotForBranchFast_(ss, branchId);
  if (fastSnapshot) return fastSnapshot;

  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
  if (!sheet || sheet.getLastRow() < 2) return null;
  return null;
}

function getLatestBalanceSnapshotForBranch_(ss, branchId) {
  const emptyMessage = "لم يتم احتساب الرصيد بعد. سيظهر الرصيد بعد أول تحديث.";
  const targetBranchId = String(branchId || "").trim();
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  if (!sheet || sheet.getLastRow() < 2) {
    return { success: true, rows: [], periodMonth: "", calculatedAt: null, runId: "", warning: "", message: emptyMessage };
  }

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balances);
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const runMap = getSuccessfulBalanceRunMap_(ss);
  const runGroups = {};

  function getRowInfo_(row, dataIndex) {
    const calcAtDate = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
    return {
      row: row,
      dataIndex: dataIndex,
      periodMonth: String(getCellByHeader_(row, headerMap, "period_month") || "").trim(),
      runId: String(getCellByHeader_(row, headerMap, "run_id") || "").trim(),
      calculatedAtDate: calcAtDate,
      calcTime: calcAtDate ? calcAtDate.getTime() : 0
    };
  }

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (rowBranchId !== targetBranchId) continue;

    const info = getRowInfo_(row, i);
    if (info.runId) {
      const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, info.runId, targetBranchId, info.periodMonth);
      if (!runMeta) continue;
      const groupKey = info.runId + "|" + info.periodMonth;
      if (!runGroups[groupKey]) {
        runGroups[groupKey] = {
          runId: info.runId,
          runMeta: runMeta,
          rows: [],
          itemIds: {},
          malformed: false,
          periodMonth: runMeta && runMeta.periodMonth ? runMeta.periodMonth : info.periodMonth,
          calculatedAt: null,
          maxCalcTime: 0,
          maxDataIndex: i + 2
        };
      }
      const group = runGroups[groupKey];
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      if (!itemId || group.itemIds[itemId]) {
        group.malformed = true;
      }
      group.itemIds[itemId] = true;
      group.rows.push(row);
      if (info.periodMonth && !group.periodMonth) group.periodMonth = info.periodMonth;
      if (info.calcTime >= group.maxCalcTime) {
        group.maxCalcTime = info.calcTime;
        group.calculatedAt = info.calculatedAtDate;
      }
      if (i + 2 > group.maxDataIndex) group.maxDataIndex = i + 2;
    }
  }

  const runGroupList = Object.keys(runGroups).map(function(runId) {
    return runGroups[runId];
  });
  if (runGroupList.length) {
    runGroupList.sort(function(a, b) {
      const aSort = a.runMeta ? a.runMeta.sortTime : a.maxCalcTime;
      const bSort = b.runMeta ? b.runMeta.sortTime : b.maxCalcTime;
      if (aSort !== bSort) return bSort - aSort;
      if (a.maxCalcTime !== b.maxCalcTime) return b.maxCalcTime - a.maxCalcTime;
      return b.maxDataIndex - a.maxDataIndex;
    });
    let latestRunGroup = null;
    for (let j = 0; j < runGroupList.length; j++) {
      const group = runGroupList[j];
      const expectedItems = Number(group.runMeta && group.runMeta.itemsProcessed || 0);
      if (!group.malformed && group.rows && group.rows.length > 0 && (!expectedItems || group.rows.length === expectedItems)) {
        latestRunGroup = group;
        break;
      }
    }
    if (latestRunGroup) {
      return {
        success: true,
        rows: latestRunGroup.rows,
        headerMap: headerMap,
        sourceSheetName: "Inventory_Balances",
        periodMonth: latestRunGroup.periodMonth || "",
        calculatedAt: latestRunGroup.calculatedAt,
        runId: latestRunGroup.runId,
        warning: "",
        message: ""
      };
    }
  }

  return {
    success: true,
    rows: [],
    periodMonth: "",
    calculatedAt: null,
    runId: "",
    warning: "",
    message: emptyMessage
  };
}

function formatBalanceSnapshotDateTime_(value) {
  const dateValue = parseSheetDate_(value);
  if (!dateValue) return "";
  return Utilities.formatDate(dateValue, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
}

function getInventoryBalancesR01Read_(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["manager"]);
    ensureRuntimeSchemaReady_();

    const formulaBalances = getFormulaInventoryBalances_(ss, user.branchId);
    if (formulaBalances) return formulaBalances;

    let snapshot = getCurrentBalanceSnapshotForBranch_(ss, user.branchId);
    let isCurrentTable = true;
    if (!snapshot) {
      snapshot = getLatestBalanceSnapshotForBranch_(ss, user.branchId);
      isCurrentTable = false;
    }
    if (!snapshot || !snapshot.rows || snapshot.rows.length === 0) {
      return {
        success: true,
        periodMonth: (snapshot && snapshot.periodMonth) || "",
        calculatedAt: "",
        balances: [],
        runId: (snapshot && snapshot.runId) || "",
        message: (snapshot && snapshot.message) || "لم يتم احتساب الرصيد بعد. سيظهر الرصيد بعد أول تحديث."
      };
    }

    const sheetName = snapshot.sourceSheetName || (isCurrentTable ? "Inventory_Balance_Current" : "Inventory_Balances");
    const sheet = snapshot.headerMap ? null : getSheetByNameCaseInsensitive_(ss, sheetName);
    const headerMap = snapshot.headerMap || requireHeaderColumns_(sheet, getInventorySchemaRequirements_()[sheetName]);
    const itemLatest = {};
    let globalLatestCalc = snapshot.calculatedAt || null;
    
    const duplicateItemIds = {};
    const duplicateItemOrder = [];
    snapshot.rows.forEach(function(row, rowIndex) {
      const pm = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
      const iId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      if (!iId) return;
      const calcAtDate = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
      const calcAtTime = calcAtDate ? calcAtDate.getTime() : 0;
      if (itemLatest[iId]) {
        duplicateItemIds[iId] = true;
        if (duplicateItemOrder.indexOf(iId) === -1) duplicateItemOrder.push(iId);
      }

      if (!itemLatest[iId] || calcAtTime > itemLatest[iId].calcTime || (calcAtTime === itemLatest[iId].calcTime && rowIndex > itemLatest[iId].rowIndex)) {
        itemLatest[iId] = {
          itemId: iId,
          periodMonth: pm || snapshot.periodMonth || "",
          startingBalance: getCellByHeader_(row, headerMap, "starting_balance"),
          totalIn: getCellByHeader_(row, headerMap, "total_in"),
          totalOut: getCellByHeader_(row, headerMap, "total_out"),
          balance: getCellByHeader_(row, headerMap, "balance"),
          calcTime: calcAtTime,
          calculatedAtDate: calcAtDate,
          rowIndex: rowIndex
        };
        if (calcAtDate && (!globalLatestCalc || calcAtTime > globalLatestCalc.getTime())) {
          globalLatestCalc = calcAtDate;
        }
      }
    });
    
    // 3. Sort by item order if available, otherwise name
    const refData = getReferenceItems_(ss);
    const refUnits = getReferenceItemUnits_(ss);
    const catalog = getItemValidationCatalog_(ss, { refItems: refData, refUnits: refUnits });
    const itemOrder = refData.itemOrder || [];
    const itemOrderMap = {};
    itemOrder.forEach(function(item, idx) {
      const id = String(item.itemId || item.id || item || "").trim();
      if (id) itemOrderMap[id] = idx;
    });
    
    const balancesArray = Object.values(itemLatest);
    balancesArray.sort((a, b) => {
      const idxA = itemOrderMap[a.itemId] !== undefined ? itemOrderMap[a.itemId] : 9999;
      const idxB = itemOrderMap[b.itemId] !== undefined ? itemOrderMap[b.itemId] : 9999;
      if (idxA !== idxB) return idxA - idxB;
      const nameA = catalog[a.itemId] ? catalog[a.itemId].nameAr : a.itemId;
      const nameB = catalog[b.itemId] ? catalog[b.itemId].nameAr : b.itemId;
      return nameA.localeCompare(nameB, 'ar');
    });
    
    // Format response
    const formattedBalances = balancesArray.map(b => ({
      itemId: b.itemId,
      itemName: catalog[b.itemId] ? catalog[b.itemId].nameAr : b.itemId,
      baseUnit: catalog[b.itemId] ? catalog[b.itemId].baseUnit : "",
      unit: catalog[b.itemId] ? catalog[b.itemId].baseUnit : "",
      periodMonth: b.periodMonth,
      startingBalance: b.startingBalance,
      totalIn: b.totalIn,
      totalOut: b.totalOut,
      balance: b.balance,
      calculatedAt: b.calculatedAtDate ? formatBalanceSnapshotDateTime_(b.calculatedAtDate) : ""
    }));
    
    const warningParts = [];
    if (snapshot.warning) warningParts.push(snapshot.warning);
    if (duplicateItemOrder.length) {
      warningParts.push("duplicate_items_in_snapshot:" + duplicateItemOrder.join(","));
    }
    const responseMessage = duplicateItemOrder.length
      ? ((snapshot.message ? snapshot.message + " " : "") + "تنبيه: توجد مواد مكررة داخل نفس لقطة الرصيد، وتم عرض آخر صف محفوظ لكل مادة.")
      : (snapshot.message || "");

    return {
      success: true,
      periodMonth: snapshot.periodMonth || "",
      calculatedAt: globalLatestCalc ? formatBalanceSnapshotDateTime_(globalLatestCalc) : "",
      runId: snapshot.runId || "",
      warning: warningParts.join("|"),
      message: responseMessage,
      balances: formattedBalances
    };
    
  } catch (e) {
    console.error("getInventoryBalances failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
    return { success: false, message: "حدث خطأ أثناء تحميل الأرصدة، يرجى المحاولة مرة أخرى لاحقاً" };
  }
}

function getSavedInventoryBalancesForBranchR01Read_(ss, branchId) {
  const emptyMessage = "لا يوجد رصيد محفوظ لهذا الفرع. شغّل إعادة حساب الرصيد أولاً.";
  const targetBranchId = String(branchId || "").trim();
  const formulaBalances = getFormulaInventoryBalances_(ss, targetBranchId);
  if (formulaBalances) return Object.assign({branchId:targetBranchId}, formulaBalances);
  let snapshot = getCurrentBalanceSnapshotForBranch_(ss, targetBranchId);
  let isCurrentTable = true;
  if (!snapshot) {
    snapshot = getLatestBalanceSnapshotForBranch_(ss, targetBranchId);
    isCurrentTable = false;
  }
  if (!snapshot || !snapshot.rows || snapshot.rows.length === 0) {
    return {
      success: true,
      branchId: targetBranchId,
      periodMonth: (snapshot && snapshot.periodMonth) || "",
      calculatedAt: "",
      runId: (snapshot && snapshot.runId) || "",
      warning: (snapshot && snapshot.warning) || "",
      message: emptyMessage,
      balances: []
    };
  }

  const sheetName = snapshot.sourceSheetName || (isCurrentTable ? "Inventory_Balance_Current" : "Inventory_Balances");
  const sheet = snapshot.headerMap ? null : getSheetByNameCaseInsensitive_(ss, sheetName);
  const headerMap = snapshot.headerMap || requireHeaderColumns_(sheet, getInventorySchemaRequirements_()[sheetName]);
  const itemLatest = {};
  const duplicateItemIds = {};
  const duplicateItemOrder = [];
  let globalLatestCalc = snapshot.calculatedAt || null;

  snapshot.rows.forEach(function(row, rowIndex) {
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (!itemId) return;
    const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();
    const calculatedAtDate = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
    const calculatedAtTime = calculatedAtDate ? calculatedAtDate.getTime() : 0;
    if (itemLatest[itemId]) {
      duplicateItemIds[itemId] = true;
      if (duplicateItemOrder.indexOf(itemId) === -1) duplicateItemOrder.push(itemId);
    }
    if (!itemLatest[itemId] || calculatedAtTime > itemLatest[itemId].calculatedAtTime || (calculatedAtTime === itemLatest[itemId].calculatedAtTime && rowIndex > itemLatest[itemId].rowIndex)) {
      itemLatest[itemId] = {
        itemId: itemId,
        periodMonth: periodMonth || snapshot.periodMonth || "",
        startingBalance: getCellByHeader_(row, headerMap, "starting_balance"),
        totalIn: getCellByHeader_(row, headerMap, "total_in"),
        totalOut: getCellByHeader_(row, headerMap, "total_out"),
        balance: getCellByHeader_(row, headerMap, "balance"),
        calculatedAtDate: calculatedAtDate,
        calculatedAtTime: calculatedAtTime,
        rowIndex: rowIndex
      };
      if (calculatedAtDate && (!globalLatestCalc || calculatedAtTime > globalLatestCalc.getTime())) {
        globalLatestCalc = calculatedAtDate;
      }
    }
  });

  const referenceItems = getReferenceItems_(ss);
  const referenceUnits = getReferenceItemUnits_(ss);
  const catalog = getItemValidationCatalog_(ss, { refItems: referenceItems, refUnits: referenceUnits });
  const itemOrderMap = {};
  (referenceItems.itemOrder || []).forEach(function(item, index) {
    const itemId = String(item.itemId || item.id || item || "").trim();
    if (itemId) itemOrderMap[itemId] = index;
  });
  const balances = Object.keys(itemLatest).map(function(itemId) {
    return itemLatest[itemId];
  });
  balances.sort(function(a, b) {
    const indexA = itemOrderMap[a.itemId] !== undefined ? itemOrderMap[a.itemId] : 9999;
    const indexB = itemOrderMap[b.itemId] !== undefined ? itemOrderMap[b.itemId] : 9999;
    if (indexA !== indexB) return indexA - indexB;
    const nameA = catalog[a.itemId] ? catalog[a.itemId].nameAr : a.itemId;
    const nameB = catalog[b.itemId] ? catalog[b.itemId].nameAr : b.itemId;
    return nameA.localeCompare(nameB, "ar");
  });

  const warningParts = [];
  if (snapshot.warning) warningParts.push(snapshot.warning);
  if (duplicateItemOrder.length) warningParts.push("duplicate_items_in_snapshot:" + duplicateItemOrder.join(","));
  const responseMessage = duplicateItemOrder.length
    ? ((snapshot.message ? snapshot.message + " " : "") + "تنبيه: توجد مواد مكررة داخل نفس لقطة الرصيد، وتم عرض آخر صف محفوظ لكل مادة.")
    : (snapshot.message || "");

  return {
    success: true,
    branchId: targetBranchId,
    periodMonth: snapshot.periodMonth || "",
    calculatedAt: globalLatestCalc ? formatBalanceSnapshotDateTime_(globalLatestCalc) : "",
    runId: snapshot.runId || "",
    warning: warningParts.join("|"),
    message: responseMessage,
    balances: balances.map(function(balanceRow) {
      const catalogItem = catalog[balanceRow.itemId] || {};
      return {
        itemId: balanceRow.itemId,
        itemName: catalogItem.nameAr || balanceRow.itemId,
        baseUnit: catalogItem.baseUnit || "",
        unit: catalogItem.baseUnit || "",
        periodMonth: balanceRow.periodMonth,
        startingBalance: balanceRow.startingBalance,
        totalIn: balanceRow.totalIn,
        totalOut: balanceRow.totalOut,
        balance: balanceRow.balance,
        calculatedAt: balanceRow.calculatedAtDate ? formatBalanceSnapshotDateTime_(balanceRow.calculatedAtDate) : ""
      };
    })
  };
}

function getOwnerBranchInventoryBalances(branchId, sessionToken, periodMonth) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    requireOwner_(ss, sessionToken);
    const branch = requireActiveBranch_(ss, branchId);
    const selectedPeriod = String(periodMonth || '').trim();
    const result = selectedPeriod ? withInventorySubmissionRead_(ss, function() {
      return getFormulaInventoryBalances_(ss, branch.id, selectedPeriod) || {success:false,message:'جهّز أرصدة المعادلات لعرض الشهر المحدد.'};
    }) : getSavedInventoryBalancesForBranch_(ss, branch.id);
    result.branchId = branch.id;
    result.branchName = branch.nameAr || branch.name || branch.id;
    return result;
  } catch (e) {
    console.error("getOwnerBranchInventoryBalances failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
    return { success: false, message: "تعذر تحميل رصيد الفرع المحفوظ. تحقق من الفرع وحاول مرة أخرى." };
  }
}

function getLatestInventoryCountsBefore_(ss, branchIds, itemIds, beforeDate, runtimeOptions) {
  const budgetOptions = runtimeOptions || {};
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  const result = {};

  const branchFilter = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (id) branchFilter[id] = true;
  });
  const itemFilter = {};
  (itemIds || []).forEach(function(itemId) {
    const id = String(itemId || "").trim();
    if (id) itemFilter[id] = true;
  });
  const useBranchFilter = Object.keys(branchFilter).length > 0;
  const useItemFilter = Object.keys(itemFilter).length > 0;
  const beforeTime = beforeDate instanceof Date ? beforeDate.getTime() : 0;
  const beforePeriod = beforeDate instanceof Date
    ? Utilities.formatDate(beforeDate, Session.getScriptTimeZone(), "yyyy-MM")
    : "";

  function countRowCutoffTime_(row, headerMap) {
    const submittedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "submitted_at"));
    const lockedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "locked_at"));
    const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
    const updatedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "updated_at"));
    // A count is effective when the manager attested it (submitted/locked).
    // A count finalized after the cutoff must not qualify via its earlier
    // draft-creation timestamps.
    const attestationTimes = [submittedAt, lockedAt]
      .filter(function(dateValue) { return !!dateValue; })
      .map(function(dateValue) { return dateValue.getTime(); });
    if (attestationTimes.length) {
      const attestedAt = Math.max.apply(null, attestationTimes);
      return (!beforeTime || attestedAt < beforeTime) ? attestedAt : 0;
    }
    const legacyTimes = [createdAt, updatedAt]
      .filter(function(dateValue) { return dateValue && (!beforeTime || dateValue.getTime() < beforeTime); })
      .map(function(dateValue) { return dateValue.getTime(); });
    return legacyTimes.length ? Math.max.apply(null, legacyTimes) : 0;
  }

  function countRowIsBeforeCalculation_(row, headerMap) {
    const timestamp = countRowCutoffTime_(row, headerMap);
    if (timestamp) return true;
    const hasAnyDate = [
      parseSheetDate_(getCellByHeader_(row, headerMap, "submitted_at")),
      parseSheetDate_(getCellByHeader_(row, headerMap, "locked_at")),
      parseSheetDate_(getCellByHeader_(row, headerMap, "created_at")),
      parseSheetDate_(getCellByHeader_(row, headerMap, "updated_at"))
    ].some(function(dateValue) { return !!dateValue; });
    if (hasAnyDate) return false;
    const rowPeriod = getInventoryCountPeriodFromRow_(row, headerMap);
    return !!(beforePeriod && rowPeriod && rowPeriod < beforePeriod);
  }

  function applyLegacyRows_() {
    if (!countsSheet || countsSheet.getLastRow() < 2) return;
    const headerMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
    assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Counts legacy read", budgetOptions.runtimeBudgetMs);
    const data = getProjectedSheetRowsByHeaders_(countsSheet, headerMap, [
      "status",
      "branch_id",
      "item_id",
      "normalized_quantity",
      "submitted_at",
      "locked_at",
      "created_at",
      "updated_at",
      "inventory_period",
      "period_month"
    ]);
    for (let i = 1; i < data.length; i++) {
      if (i % 100 === 0) assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Counts legacy scan", budgetOptions.runtimeBudgetMs);
      const row = data[i];
      const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
      if (!isFinalInventoryCountStatus_(status)) continue;

      const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      if (!branchId || !itemId) continue;
      if (useBranchFilter && !branchFilter[branchId]) continue;
      if (useItemFilter && !itemFilter[itemId]) continue;
      if (!countRowIsBeforeCalculation_(row, headerMap)) continue;

      const countTime = countRowCutoffTime_(row, headerMap);
      if (!result[branchId]) result[branchId] = {};
      const existing = result[branchId][itemId];
      if (!existing || (existing.source === "legacy" && countTime > existing.timestamp)) {
        result[branchId][itemId] = {
          normalizedQuantity: parseSheetNumber_(getCellByHeader_(row, headerMap, "normalized_quantity"), 0),
          timestamp: countTime,
          source: "legacy"
        };
      }
    }
  }

  if (!countsSheet || countsSheet.getLastRow() < 2) {
    return result;
  }

  const countsHeaderMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Counts header read", budgetOptions.runtimeBudgetMs);
  const countsData = getProjectedSheetRowsByHeaders_(countsSheet, countsHeaderMap, [
    "status",
    "branch_id",
    "count_id",
    "item_id",
    "submitted_at",
    "locked_at",
    "created_at",
    "updated_at",
    "inventory_period",
    "period_month"
  ]);
  const latestHeaderByBranch = {};

  for (let i = 1; i < countsData.length; i++) {
    if (i % 100 === 0) assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Counts header scan", budgetOptions.runtimeBudgetMs);
    const row = countsData[i];
    const status = String(getCellByHeader_(row, countsHeaderMap, "status") || "").trim().toLowerCase();
    if (!isFinalInventoryCountStatus_(status)) continue;

    const branchId = String(getCellByHeader_(row, countsHeaderMap, "branch_id") || "").trim();
    const countId = String(getCellByHeader_(row, countsHeaderMap, "count_id") || "").trim();
    const legacyItemId = String(getCellByHeader_(row, countsHeaderMap, "item_id") || "").trim();
    if (!branchId || !countId || legacyItemId) continue;
    if (useBranchFilter && !branchFilter[branchId]) continue;
    if (!countRowIsBeforeCalculation_(row, countsHeaderMap)) continue;

    const timestamp = countRowCutoffTime_(row, countsHeaderMap);
    if (!latestHeaderByBranch[branchId] || timestamp > latestHeaderByBranch[branchId].timestamp) {
      latestHeaderByBranch[branchId] = {
        countId: countId,
        timestamp: timestamp
      };
    }
  }

  const selectedCountIds = {};
  Object.keys(latestHeaderByBranch).forEach(function(branchId) {
    selectedCountIds[latestHeaderByBranch[branchId].countId] = {
      branchId: branchId,
      timestamp: latestHeaderByBranch[branchId].timestamp
    };
  });

  const linesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Count_Lines");
  if (linesSheet && linesSheet.getLastRow() > 1 && Object.keys(selectedCountIds).length > 0) {
    const linesHeaderMap = requireHeaderColumns_(linesSheet, getInventorySchemaRequirements_().Inventory_Count_Lines);
    assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Count_Lines read", budgetOptions.runtimeBudgetMs);
    const linesData = getProjectedSheetRowsByHeaders_(linesSheet, linesHeaderMap, [
      "count_id",
      "branch_id",
      "item_id",
      "normalized_quantity"
    ]);
    for (let i = 1; i < linesData.length; i++) {
      if (i % 100 === 0) assertBalanceRuntimeBudget_(budgetOptions.startedAtMs, "Inventory_Count_Lines scan", budgetOptions.runtimeBudgetMs);
      const row = linesData[i];
      const countId = String(getCellByHeader_(row, linesHeaderMap, "count_id") || "").trim();
      const selected = selectedCountIds[countId];
      if (!selected) continue;

      const branchId = String(getCellByHeader_(row, linesHeaderMap, "branch_id") || selected.branchId).trim();
      const itemId = String(getCellByHeader_(row, linesHeaderMap, "item_id") || "").trim();
      if (!branchId || !itemId) continue;
      if (useBranchFilter && !branchFilter[branchId]) continue;
      if (useItemFilter && !itemFilter[itemId]) continue;

      if (!result[branchId]) result[branchId] = {};
      result[branchId][itemId] = {
        normalizedQuantity: parseSheetNumber_(getCellByHeader_(row, linesHeaderMap, "normalized_quantity"), 0),
        timestamp: selected.timestamp,
        source: "lines",
        countId: countId
      };
    }
  }

  applyLegacyRows_();
  Object.keys(result).forEach(function(branchId) {
    Object.keys(result[branchId]).forEach(function(itemId) {
      delete result[branchId][itemId].source;
      delete result[branchId][itemId].countId;
    });
  });

  return result;
}

function getReceivedNormalizedQuantityForBalance_(row, headerMap) {
  const rawValue = getCellByHeader_(row, headerMap, "received_normalized_quantity");
  const parsed = rawValue === 0 ? 0 : parseNumericInput_(rawValue);
  return isNaN(parsed) ? null : parsed;
}

function createBalanceRunId_() {
  const now = new Date();
  const timestamp = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyyMMddHHmmss") + "-" + now.getTime();
  const random = Math.floor(Math.random() * 1000000);
  return "BAL-RUN-" + timestamp + "-" + random;
}

function appendBalanceRunLog_(ss, runData) {
  let sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Run_Log");
  if (!sheet) {
    sheet = ss.insertSheet("Inventory_Balance_Run_Log");
    sheet.getRange(1, 1, 1, getInventorySchemaRequirements_().Inventory_Balance_Run_Log.length)
      .setValues([getInventorySchemaRequirements_().Inventory_Balance_Run_Log]);
  }

  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Inventory_Balance_Run_Log);
  const data = runData || {};
  const row = buildRowByHeaders_(headerMap, {
    run_id: data.run_id || "",
    trigger_type: data.trigger_type || "",
    period_start: data.period_start || "",
    period_end: data.period_end || "",
    period_month: data.period_month || "",
    branch_id: data.branch_id || "",
    status: data.status || "",
    branches_processed: data.branches_processed || 0,
    items_processed: data.items_processed || 0,
    started_at: data.started_at || "",
    finished_at: data.finished_at || "",
    created_by: data.created_by || "",
    message: data.message || ""
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headerMap.__lastColumn).setValues([row]);
  return { success: true, rowNumber: sheet.getLastRow() };
}

function appendBalanceRunLogWithLock_(ss, runData, lockWaitMs) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lockAcquired = lock.tryLock(lockWaitMs === undefined ? 5000 : Number(lockWaitMs));
    if (!lockAcquired) {
      return { success: false, message: "تعذر تسجيل نتيجة التشغيل لأن قفل النظام مشغول." };
    }
    return appendBalanceRunLog_(ss, runData);
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function getBalancePeriodBounds_(periodMonth) {
  const targetPeriodMonth = String(periodMonth || "").trim();
  if (!targetPeriodMonth || !/^\d{4}-\d{2}$/.test(targetPeriodMonth)) {
    throw new Error("صيغة الشهر غير صحيحة.");
  }

  const parts = targetPeriodMonth.split("-");
  const year = Number(parts[0]);
  const monthIndex = Number(parts[1]) - 1;
  return {
    periodMonth: targetPeriodMonth,
    periodStart: new Date(year, monthIndex, 1),
    periodEnd: new Date(year, monthIndex + 1, 0, 23, 59, 59, 999)
  };
}


const BALANCE_RECALC_GUARD_TTL_SECONDS = 600;
const BALANCE_RECALC_GUARD_BUSY_MESSAGE = "إعادة حساب الرصيد لهذا الفرع قيد التنفيذ حالياً. يرجى الانتظار ثم تحديث الرصيد.";
const BALANCE_RUNTIME_BUDGET_MS = 240000;
const BALANCE_RUNTIME_BUDGET_EXCEEDED_MESSAGE = "استغرقت إعادة حساب الرصيد وقتاً طويلاً قبل إكمال العملية. لم يتم اعتماد نتيجة جديدة، وبقي آخر رصيد موثوق كما هو.";

function getBalanceRecalcGuardKey_(branchId, periodMonth) {
  return "balance_recalc_guard:" + String(branchId || "").trim() + ":" + String(periodMonth || "").trim();
}

function tryAcquireBalanceRecalcGuard_(branchId, periodMonth, ownerEmployeeNumber) {
  const key = getBalanceRecalcGuardKey_(branchId, periodMonth);
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lockAcquired = lock.tryLock(1000);
    if (!lockAcquired) return { acquired: false, key: key };
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return { acquired: false, key: key };
    cache.put(key, JSON.stringify({
      branchId: String(branchId || "").trim(),
      periodMonth: String(periodMonth || "").trim(),
      startedAt: new Date().toISOString(),
      createdBy: String(ownerEmployeeNumber || "").trim()
    }), BALANCE_RECALC_GUARD_TTL_SECONDS);
    return { acquired: true, key: key };
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function clearBalanceRecalcGuard_(guardKey) {
  const key = String(guardKey || "").trim();
  if (!key) return;
  try {
    CacheService.getScriptCache().remove(key);
  } catch (e) {
    console.error("clearBalanceRecalcGuard_ failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
  }
}

function assertBalanceRuntimeBudget_(startedAtMs, stageName, runtimeBudgetMs) {
  const startedAt = Number(startedAtMs || 0);
  const budgetMs = Number(runtimeBudgetMs || 0);
  if (!startedAt || !budgetMs) return;
  if (new Date().getTime() - startedAt <= budgetMs) return;
  const err = new Error(BALANCE_RUNTIME_BUDGET_EXCEEDED_MESSAGE);
  err.balanceRuntimeBudgetExceeded = true;
  err.balanceRuntimeStage = String(stageName || "").trim();
  throw err;
}

function isOwnerManualBalanceTrigger_(triggerType) {
  const normalized = String(triggerType || "").trim().toUpperCase();
  return normalized === "OWNER_MANUAL" || normalized === "MANUAL_OWNER";
}

function getBalanceBaselineHeaders_() {
  return [
    "baseline_id",
    "branch_id",
    "item_id",
    "period_month",
    "effective_date",
    "starting_balance",
    "reason",
    "created_by",
    "created_at",
    "status",
    "batch_id",
    "request_digest",
    "preview_token_digest",
    "baseline_mode",
    "expected_row_count",
    "expected_branch_digest",
    "expected_item_digest",
    "expected_manifest_digest"
  ];
}

function ensureBalanceBaselinesSchema_(ss) {
  const headers = getBalanceBaselineHeaders_();
  let sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Baselines");
  if (!sheet) {
    sheet = ss.insertSheet("Inventory_Balance_Baselines");
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return { sheet: sheet, headerMap: getHeaderMap_(sheet), created: true, addedHeaders: headers.slice() };
  }

  const existingHeaderMap = getHeaderMap_(sheet);
  const missingHeaders = headers.filter(function(header) {
    return !getHeaderIndex_(existingHeaderMap, header);
  });
  if (missingHeaders.length) {
    const startColumn = Math.max(1, sheet.getLastColumn() + 1);
    sheet.getRange(1, startColumn, 1, missingHeaders.length).setValues([missingHeaders]);
  }
  return {
    sheet: sheet,
    headerMap: getHeaderMap_(sheet),
    created: false,
    addedHeaders: missingHeaders
  };
}

function computeMonthlyBaselineDigest_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value === null || value === undefined ? "" : value),
    Utilities.Charset.UTF_8
  );
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    let byteValue = bytes[i];
    if (byteValue < 0) byteValue += 256;
    const part = byteValue.toString(16);
    hex += part.length === 1 ? "0" + part : part;
  }
  return hex;
}

function getMonthlyBaselineQuantityKey_(value) {
  const quantity = Number(value);
  if (!isFinite(quantity)) throw new Error("baseline_quantity_not_finite");
  return quantity === 0 ? "0" : String(quantity);
}

function buildMonthlyBaselineOperationIdentity_(validated, ownerEmployeeNumber, previewToken) {
  const branchIds = (validated.branchIds || []).map(function(branchId) {
    return String(branchId || "").trim();
  }).sort();
  const requestPayload = {
    action: getMonthlyBaselineResetMutationAction_(validated),
    ownerEmployeeNumber: normalizeEmployeeNumber_(ownerEmployeeNumber),
    periodMonth: validated.periodMonth,
    effectiveDate: validated.effectiveDate,
    mode: validated.mode,
    branchIds: branchIds,
    includeZeroQuantityItems: true
  };
  return {
    requestDigest: computeMonthlyBaselineDigest_(JSON.stringify(requestPayload)),
    previewTokenDigest: computeMonthlyBaselineDigest_(String(previewToken || "").trim()),
    mode: validated.mode,
    periodMonth: validated.periodMonth,
    effectiveDate: validated.effectiveDate,
    ownerEmployeeNumber: normalizeEmployeeNumber_(ownerEmployeeNumber)
  };
}

function buildMonthlyBaselineExpectedBatch_(validated, catalog, branchPlans, ownerEmployeeNumber, previewToken) {
  const branchIds = (validated.branchIds || []).map(function(branchId) {
    return String(branchId || "").trim();
  }).sort();
  const itemIds = (catalog.itemIds || []).map(function(itemId) {
    return String(itemId || "").trim();
  }).sort();
  const rows = [];
  const rowByPair = {};
  const sourceAudit = [];

  (branchPlans || []).forEach(function(plan) {
    const branchId = String(plan && plan.branchId || "").trim();
    const source = plan && plan.source ? plan.source : {};
    sourceAudit.push({
      branchId: branchId,
      sourceType: String(source.sourceType || ""),
      sourcePeriodMonth: String(source.sourcePeriodMonth || ""),
      sourceDate: String(source.sourceDate || ""),
      sourceCountId: String(source.sourceCountId || ""),
      sourceRunId: String(source.sourceRunId || "")
    });
    itemIds.forEach(function(itemId) {
      const quantity = Number(source.quantities && source.quantities[itemId]);
      const quantityKey = getMonthlyBaselineQuantityKey_(quantity);
      const pairKey = JSON.stringify([branchId, itemId]);
      const expectedRow = {
        pairKey: pairKey,
        branchId: branchId,
        itemId: itemId,
        quantity: quantity,
        quantityKey: quantityKey
      };
      rows.push(expectedRow);
      rowByPair[pairKey] = expectedRow;
    });
  });
  rows.sort(function(a, b) { return a.pairKey < b.pairKey ? -1 : (a.pairKey > b.pairKey ? 1 : 0); });
  sourceAudit.sort(function(a, b) { return a.branchId < b.branchId ? -1 : (a.branchId > b.branchId ? 1 : 0); });

  const operationIdentity = buildMonthlyBaselineOperationIdentity_(validated, ownerEmployeeNumber, previewToken);
  const manifestPayload = rows.map(function(row) {
    return [row.branchId, row.itemId, row.quantityKey];
  });
  return {
    mode: validated.mode,
    periodMonth: validated.periodMonth,
    effectiveDate: validated.effectiveDate,
    ownerEmployeeNumber: normalizeEmployeeNumber_(ownerEmployeeNumber),
    branchIds: branchIds,
    itemIds: itemIds,
    rows: rows,
    rowByPair: rowByPair,
    sourceAudit: sourceAudit,
    expectedRowCount: rows.length,
    requestDigest: operationIdentity.requestDigest,
    previewTokenDigest: operationIdentity.previewTokenDigest,
    expectedBranchDigest: computeMonthlyBaselineDigest_(JSON.stringify(branchIds)),
    expectedItemDigest: computeMonthlyBaselineDigest_(JSON.stringify(itemIds)),
    expectedManifestDigest: computeMonthlyBaselineDigest_(JSON.stringify(manifestPayload))
  };
}

function getMonthlyBaselineDateKey_(value) {
  const parsed = parseSheetDate_(value);
  if (!parsed) return "";
  return Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function inspectMonthlyBaselineBatch_(schema, batchId, expected) {
  const result = {
    found: false,
    complete: false,
    active: false,
    pending: false,
    mixedStatus: false,
    recoverablePending: false,
    duplicateItems: [],
    missingItems: [],
    unexpectedItems: [],
    invalidQuantities: [],
    rowCount: 0,
    expectedRowCount: 0,
    batchId: String(batchId || "").trim(),
    rowNumbers: [],
    pendingRowNumbers: [],
    activeRowNumbers: [],
    missingRows: [],
    actualBranchIds: [],
    actualItemIds: [],
    metadataMatches: false
  };
  if (!schema || !schema.sheet || !result.batchId || schema.sheet.getLastRow() < 2) return result;

  const headerMap = schema.headerMap;
  const allRows = schema.sheet.getRange(2, 1, schema.sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const pairSeen = {};
  const actualRows = [];
  const actualBranches = {};
  const actualItems = {};
  const metadataValues = {
    requestDigest: {},
    previewTokenDigest: {},
    mode: {},
    expectedRowCount: {},
    branchDigest: {},
    itemDigest: {},
    manifestDigest: {},
    periodMonth: {},
    effectiveDate: {},
    createdBy: {}
  };

  allRows.forEach(function(row, index) {
    const rowBatchId = String(getCellByHeader_(row, headerMap, "batch_id") || "").trim();
    if (rowBatchId !== result.batchId) return;
    result.found = true;
    result.rowCount++;
    const rowNumber = index + 2;
    result.rowNumbers.push(rowNumber);
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    const pairKey = JSON.stringify([branchId, itemId]);
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    const quantity = Number(getCellByHeader_(row, headerMap, "starting_balance"));
    if (status === "pending") result.pendingRowNumbers.push(rowNumber);
    if (status === "active") result.activeRowNumbers.push(rowNumber);
    if (pairSeen[pairKey]) result.duplicateItems.push(pairKey);
    pairSeen[pairKey] = true;
    actualBranches[branchId] = true;
    actualItems[itemId] = true;
    if (!isFinite(quantity)) result.invalidQuantities.push(pairKey);
    actualRows.push({
      pairKey: pairKey,
      branchId: branchId,
      itemId: itemId,
      quantity: quantity,
      quantityKey: isFinite(quantity) ? getMonthlyBaselineQuantityKey_(quantity) : "invalid"
    });

    metadataValues.requestDigest[String(getCellByHeader_(row, headerMap, "request_digest") || "").trim()] = true;
    metadataValues.previewTokenDigest[String(getCellByHeader_(row, headerMap, "preview_token_digest") || "").trim()] = true;
    metadataValues.mode[String(getCellByHeader_(row, headerMap, "baseline_mode") || "").trim()] = true;
    metadataValues.expectedRowCount[String(getCellByHeader_(row, headerMap, "expected_row_count") || "").trim()] = true;
    metadataValues.branchDigest[String(getCellByHeader_(row, headerMap, "expected_branch_digest") || "").trim()] = true;
    metadataValues.itemDigest[String(getCellByHeader_(row, headerMap, "expected_item_digest") || "").trim()] = true;
    metadataValues.manifestDigest[String(getCellByHeader_(row, headerMap, "expected_manifest_digest") || "").trim()] = true;
    metadataValues.periodMonth[normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "period_month"))] = true;
    metadataValues.effectiveDate[getMonthlyBaselineDateKey_(getCellByHeader_(row, headerMap, "effective_date"))] = true;
    metadataValues.createdBy[normalizeEmployeeNumber_(getCellByHeader_(row, headerMap, "created_by"))] = true;
  });
  if (!result.found) return result;

  const singleValue = function(values) {
    const keys = Object.keys(values);
    return keys.length === 1 && keys[0] ? keys[0] : "";
  };
  const stored = {
    requestDigest: singleValue(metadataValues.requestDigest),
    previewTokenDigest: singleValue(metadataValues.previewTokenDigest),
    mode: singleValue(metadataValues.mode),
    expectedRowCount: Number(singleValue(metadataValues.expectedRowCount)),
    branchDigest: singleValue(metadataValues.branchDigest),
    itemDigest: singleValue(metadataValues.itemDigest),
    manifestDigest: singleValue(metadataValues.manifestDigest),
    periodMonth: singleValue(metadataValues.periodMonth),
    effectiveDate: singleValue(metadataValues.effectiveDate),
    createdBy: singleValue(metadataValues.createdBy)
  };
  result.expectedRowCount = stored.expectedRowCount;

  actualRows.sort(function(a, b) { return a.pairKey < b.pairKey ? -1 : (a.pairKey > b.pairKey ? 1 : 0); });
  const actualBranchIds = Object.keys(actualBranches).sort();
  const actualItemIds = Object.keys(actualItems).sort();
  result.actualBranchIds = actualBranchIds;
  result.actualItemIds = actualItemIds;
  const actualManifest = actualRows.map(function(row) { return [row.branchId, row.itemId, row.quantityKey]; });
  const actualBranchDigest = computeMonthlyBaselineDigest_(JSON.stringify(actualBranchIds));
  const actualItemDigest = computeMonthlyBaselineDigest_(JSON.stringify(actualItemIds));
  const actualManifestDigest = computeMonthlyBaselineDigest_(JSON.stringify(actualManifest));

  const expectedMetadataMatches = !expected || (
    (!expected.requestDigest || stored.requestDigest === expected.requestDigest) &&
    (!expected.previewTokenDigest || stored.previewTokenDigest === expected.previewTokenDigest) &&
    (!expected.mode || stored.mode === expected.mode) &&
    (!expected.periodMonth || stored.periodMonth === expected.periodMonth) &&
    (!expected.effectiveDate || stored.effectiveDate === expected.effectiveDate) &&
    (!expected.ownerEmployeeNumber || stored.createdBy === normalizeEmployeeNumber_(expected.ownerEmployeeNumber)) &&
    (!expected.expectedRowCount || stored.expectedRowCount === expected.expectedRowCount) &&
    (!expected.expectedBranchDigest || stored.branchDigest === expected.expectedBranchDigest) &&
    (!expected.expectedItemDigest || stored.itemDigest === expected.expectedItemDigest) &&
    (!expected.expectedManifestDigest || stored.manifestDigest === expected.expectedManifestDigest)
  );
  result.metadataMatches = !!(
    stored.requestDigest && stored.previewTokenDigest && stored.mode && stored.periodMonth && stored.effectiveDate &&
    stored.createdBy && stored.expectedRowCount > 0 && stored.branchDigest && stored.itemDigest && stored.manifestDigest &&
    expectedMetadataMatches
  );

  if (expected && expected.rowByPair) {
    actualRows.forEach(function(row) {
      const expectedRow = expected.rowByPair[row.pairKey];
      if (!expectedRow || expectedRow.quantityKey !== row.quantityKey) result.unexpectedItems.push(row.pairKey);
    });
    expected.rows.forEach(function(row) {
      if (!pairSeen[row.pairKey]) {
        result.missingItems.push(row.pairKey);
        result.missingRows.push(row);
      }
    });
  }

  const allPending = result.pendingRowNumbers.length === result.rowCount;
  const allActive = result.activeRowNumbers.length === result.rowCount;
  const recognizedStatuses = result.pendingRowNumbers.length + result.activeRowNumbers.length === result.rowCount;
  const independentlyComplete = result.metadataMatches &&
    result.rowCount === stored.expectedRowCount &&
    result.duplicateItems.length === 0 &&
    result.invalidQuantities.length === 0 &&
    actualBranchDigest === stored.branchDigest &&
    actualItemDigest === stored.itemDigest &&
    actualManifestDigest === stored.manifestDigest &&
    recognizedStatuses;
  result.complete = independentlyComplete && result.missingItems.length === 0 && result.unexpectedItems.length === 0;
  result.pending = result.complete && allPending;
  result.active = result.complete && allActive;
  result.mixedStatus = result.complete && !allPending && !allActive && recognizedStatuses;
  result.recoverablePending = result.metadataMatches && allPending &&
    result.rowCount < stored.expectedRowCount &&
    result.duplicateItems.length === 0 &&
    result.invalidQuantities.length === 0 &&
    result.unexpectedItems.length === 0 &&
    result.missingRows.length === stored.expectedRowCount - result.rowCount;
  return result;
}

function findMonthlyBaselineBatchIdByOperation_(schema, previewTokenDigest) {
  const targetDigest = String(previewTokenDigest || "").trim();
  if (!targetDigest || !schema || !schema.sheet || schema.sheet.getLastRow() < 2) return "";
  const rows = schema.sheet.getRange(2, 1, schema.sheet.getLastRow() - 1, schema.headerMap.__lastColumn).getValues();
  const batchIds = {};
  rows.forEach(function(row) {
    const digest = String(getCellByHeader_(row, schema.headerMap, "preview_token_digest") || "").trim();
    if (digest !== targetDigest) return;
    const batchId = String(getCellByHeader_(row, schema.headerMap, "batch_id") || "").trim();
    if (batchId) batchIds[batchId] = true;
  });
  const matches = Object.keys(batchIds);
  if (matches.length > 1) throw new Error("baseline_operation_identity_ambiguous");
  return matches.length === 1 ? matches[0] : "";
}

function hasConflictingMonthlyBaselineBatch_(schema, branchIds, periodMonth, excludedBatchId) {
  if (!schema || !schema.sheet || schema.sheet.getLastRow() < 2) return false;
  const requested = {};
  (branchIds || []).forEach(function(branchId) { requested[String(branchId || "").trim()] = true; });
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const rows = schema.sheet.getRange(2, 1, schema.sheet.getLastRow() - 1, schema.headerMap.__lastColumn).getValues();
  return rows.some(function(row) {
    const batchId = String(getCellByHeader_(row, schema.headerMap, "batch_id") || "").trim();
    if (excludedBatchId && batchId === excludedBatchId) return false;
    const branchId = String(getCellByHeader_(row, schema.headerMap, "branch_id") || "").trim();
    const rowPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(row, schema.headerMap, "period_month"));
    const status = String(getCellByHeader_(row, schema.headerMap, "status") || "").trim().toLowerCase();
    return requested[branchId] === true && rowPeriod === targetPeriod && (status === "active" || status === "pending");
  });
}

function buildMonthlyBaselineRows_(schema, batchId, validated, expectation, userEmployeeNumber, createdAt, expectedRows) {
  const rowsToBuild = Array.isArray(expectedRows) ? expectedRows : expectation.rows;
  return rowsToBuild.map(function(expectedRow, index) {
    return buildRowByHeaders_(schema.headerMap, {
      baseline_id: batchId + "-" + expectedRow.branchId + "-" + expectedRow.itemId + "-" + (index + 1),
      branch_id: expectedRow.branchId,
      item_id: expectedRow.itemId,
      period_month: validated.periodMonth,
      effective_date: validated.effectiveDateObject,
      starting_balance: expectedRow.quantity,
      reason: "رصيد بداية شهر - " + getMonthlyBaselineResetModeLabelAr_(validated.mode),
      created_by: userEmployeeNumber,
      created_at: createdAt,
      status: "pending",
      batch_id: batchId,
      request_digest: expectation.requestDigest,
      preview_token_digest: expectation.previewTokenDigest,
      baseline_mode: validated.mode,
      expected_row_count: expectation.expectedRowCount,
      expected_branch_digest: expectation.expectedBranchDigest,
      expected_item_digest: expectation.expectedItemDigest,
      expected_manifest_digest: expectation.expectedManifestDigest
    });
  });
}

function activateVerifiedMonthlyBaselineBatch_(schema, batchId, expected) {
  const before = inspectMonthlyBaselineBatch_(schema, batchId, expected);
  if (!before.complete || (!before.pending && !before.mixedStatus)) {
    throw new Error("baseline_pending_verification_failed");
  }
  if (before.pendingRowNumbers.length) {
    const statusColumn = getHeaderIndex_(schema.headerMap, "status");
    if (!statusColumn) throw new Error("baseline_status_header_missing");
    const ranges = before.pendingRowNumbers.map(function(rowNumber) {
      return schema.sheet.getRange(rowNumber, statusColumn, 1, 1).getA1Notation();
    });
    bumpBalanceSourceVersion_();
    schema.sheet.getRangeList(ranges).setValue("active");
    SpreadsheetApp.flush();
  }
  const after = inspectMonthlyBaselineBatch_(schema, batchId, expected);
  if (!after.complete || !after.active || after.pendingRowNumbers.length) {
    throw new Error("baseline_activation_verification_failed");
  }
  return after;
}

function buildMonthlyBaselineCommittedResponse_(validated, expectation, batchId, reconciled, alreadyCommitted, warning) {
  return {
    success: true,
    committed: true,
    reconciled: reconciled === true,
    alreadyCommitted: alreadyCommitted === true,
    baselineBatchId: batchId,
    warning: String(warning || ""),
    status: "active",
    periodMonth: validated.periodMonth,
    effectiveDate: validated.effectiveDate,
    mode: validated.mode,
    branchIds: validated.branchIds,
    branchCount: validated.branchIds.length,
    itemCount: expectation.itemIds.length,
    rowCount: expectation.expectedRowCount,
    automaticRecalculation: false,
    message: "تم إنشاء وتفعيل رصيد بداية الشهر بدون حذف السجل القديم وبدون إعادة حساب تلقائية."
  };
}

function parseBalanceBaselineEffectiveDate_(effectiveDate, periodMonth) {
  const periodText = String(periodMonth || "").trim();
  const periodMatch = /^(\d{4})-(\d{2})$/.exec(periodText);
  if (!periodMatch || Number(periodMatch[2]) < 1 || Number(periodMatch[2]) > 12) {
    throw new Error("صيغة الشهر غير صحيحة. استخدم YYYY-MM.");
  }

  const dateText = String(effectiveDate || "").trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!dateMatch) {
    throw new Error("التاريخ الفعّال غير صالح.");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const parsedDate = new Date(year, month - 1, day);
  if (
    parsedDate.getFullYear() !== year ||
    parsedDate.getMonth() !== month - 1 ||
    parsedDate.getDate() !== day
  ) {
    throw new Error("التاريخ الفعّال غير صالح.");
  }
  if (dateText.slice(0, 7) !== periodText) {
    throw new Error("يجب أن يكون التاريخ الفعّال ضمن الشهر المحدد.");
  }
  return parsedDate;
}

function getActiveBalanceBaselineMapForBranchPeriod_(ss, branchId, periodMonth) {
  const targetBranchId = String(branchId || "").trim();
  const targetPeriodMonth = normalizeInventoryPeriodValue_(periodMonth);
  const result = { byBranch: {} };
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Baselines");
  if (!sheet || sheet.getLastRow() < 2) return result;

  const requiredHeaders = getBalanceBaselineHeaders_().slice(0, 10);
  const headerMap = requireHeaderColumns_(sheet, requiredHeaders);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  rows.forEach(function(row) {
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    if (status !== "active") return;
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const rowPeriodMonth = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "period_month"));
    if (!rowBranchId || rowPeriodMonth !== targetPeriodMonth) return;
    if (targetBranchId && rowBranchId !== targetBranchId) return;

    const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
    if (!itemId) throw new Error("توجد بيانات تصفير فعالة بدون مادة محددة.");
    const effectiveDate = parseSheetDate_(getCellByHeader_(row, headerMap, "effective_date"));
    if (!effectiveDate) throw new Error("توجد بيانات تصفير فعالة بتاريخ غير صالح.");
    const effectiveDateKey = Utilities.formatDate(effectiveDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
    if (effectiveDateKey.slice(0, 7) !== targetPeriodMonth) {
      throw new Error("تاريخ التصفير الفعّال لا ينتمي إلى شهر التصفير.");
    }

    if (!result.byBranch[rowBranchId]) {
      result.byBranch[rowBranchId] = {
        effectiveDate: effectiveDate,
        effectiveDateKey: effectiveDateKey,
        items: {}
      };
    }
    const branchBaseline = result.byBranch[rowBranchId];
    if (branchBaseline.effectiveDateKey !== effectiveDateKey) {
      throw new Error("توجد تواريخ فعالة متعارضة لتصفير الرصيد لنفس الفرع والشهر.");
    }
    if (Object.prototype.hasOwnProperty.call(branchBaseline.items, itemId)) {
      throw new Error("توجد مادة مكررة في تصفير الرصيد الفعّال لنفس الفرع والشهر.");
    }
    branchBaseline.items[itemId] = parseSheetNumber_(getCellByHeader_(row, headerMap, "starting_balance"), 0);
  });
  return result;
}

function hasActiveBalanceBaselineForBranchPeriod_(sheet, headerMap, branchId, periodMonth) {
  const targetBranchId = String(branchId || "").trim();
  const targetPeriodMonth = normalizeInventoryPeriodValue_(periodMonth);
  if (!sheet || sheet.getLastRow() < 2 || !targetBranchId || !targetPeriodMonth) return false;

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  return rows.some(function(row) {
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    const rowPeriodMonth = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "period_month"));
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    return rowBranchId === targetBranchId && rowPeriodMonth === targetPeriodMonth && status === "active";
  });
}

function getBaselineEffectiveDateForBranchPeriod_(baselineMap, branchId, defaultDate) {
  const branchBaseline = baselineMap && baselineMap.byBranch
    ? baselineMap.byBranch[String(branchId || "").trim()]
    : null;
  return branchBaseline && branchBaseline.effectiveDate ? branchBaseline.effectiveDate : defaultDate;
}

function createMonthlyBaselinePreviewError_(message) {
  const error = new Error(String(message || "تعذر تجهيز معاينة رصيد بداية الشهر."));
  error.monthlyBaselinePreviewSafe = true;
  return error;
}

function normalizeMonthlyBalanceBaselineResetOptions_(options) {
  const raw = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const periodMonth = normalizeInventoryPeriodValue_(raw.periodMonth);
  const branchIds = Array.isArray(raw.branchIds) ? raw.branchIds.map(function(branchId) {
    return String(branchId || "").trim();
  }) : [];
  return {
    periodMonth: periodMonth,
    branchIds: branchIds,
    mode: String(raw.mode || "").trim(),
    effectiveDate: String(raw.effectiveDate || "").trim(),
    includeZeroQuantityItems: raw.includeZeroQuantityItems === true,
    confirmationText: String(raw.confirmationText || ""),
    note: String(raw.note || "").trim()
  };
}

function validateMonthlyBaselineResetOptions_(ss, normalizedOptions) {
  const opts = normalizedOptions || {};
  if (!/^\d{4}-\d{2}$/.test(opts.periodMonth || "")) {
    throw createMonthlyBaselinePreviewError_("صيغة شهر رصيد بداية الشهر غير صحيحة. استخدم YYYY-MM.");
  }
  const monthNumber = Number(String(opts.periodMonth).slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    throw createMonthlyBaselinePreviewError_("صيغة شهر رصيد بداية الشهر غير صحيحة. استخدم YYYY-MM.");
  }

  const allowedModes = ["from_inventory_count", "from_latest_snapshot", "zero_reset"];
  if (allowedModes.indexOf(opts.mode) === -1) {
    throw createMonthlyBaselinePreviewError_("طريقة رصيد بداية الشهر المحددة غير صالحة.");
  }
  if (opts.includeZeroQuantityItems !== true) {
    throw createMonthlyBaselinePreviewError_("يجب تضمين المواد ذات الرصيد الصفري في الإصدار الحالي.");
  }
  if (opts.note.length > 500) {
    throw createMonthlyBaselinePreviewError_("ملاحظة رصيد بداية الشهر يجب ألا تتجاوز 500 حرف.");
  }
  if (!Array.isArray(opts.branchIds) || opts.branchIds.length === 0) {
    throw createMonthlyBaselinePreviewError_("الرجاء تحديد فرع واحد نشط على الأقل.");
  }

  const branchSeen = {};
  const branches = [];
  for (let i = 0; i < opts.branchIds.length; i++) {
    const branchId = String(opts.branchIds[i] || "").trim();
    if (!branchId) {
      throw createMonthlyBaselinePreviewError_("قائمة الفروع تحتوي على فرع غير صالح.");
    }
    if (/^(all|all_branches|\*)$/i.test(branchId)) {
      throw createMonthlyBaselinePreviewError_("يجب إرسال أرقام الفروع النشطة صراحةً، ولا يمكن استخدام خيار كل الفروع المختصر.");
    }
    if (branchSeen[branchId]) {
      throw createMonthlyBaselinePreviewError_("قائمة الفروع تحتوي على فرع مكرر.");
    }
    branchSeen[branchId] = true;
    try {
      branches.push(requireActiveBranch_(ss, branchId));
    } catch (e) {
      throw createMonthlyBaselinePreviewError_("أحد الفروع المحددة غير نشط أو غير موجود.");
    }
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(opts.effectiveDate || "");
  if (!dateMatch) {
    throw createMonthlyBaselinePreviewError_("التاريخ الفعّال لرصيد بداية الشهر غير صالح.");
  }
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const effectiveDateObject = new Date(year, month - 1, day);
  if (
    effectiveDateObject.getFullYear() !== year ||
    effectiveDateObject.getMonth() !== month - 1 ||
    effectiveDateObject.getDate() !== day
  ) {
    throw createMonthlyBaselinePreviewError_("التاريخ الفعّال لرصيد بداية الشهر غير صالح.");
  }
  if (opts.effectiveDate.slice(0, 7) !== opts.periodMonth) {
    throw createMonthlyBaselinePreviewError_("يجب أن يكون التاريخ الفعّال ضمن شهر رصيد البداية المحدد.");
  }
  if (day !== 1) {
    throw createMonthlyBaselinePreviewError_("يجب أن يكون التاريخ الفعّال هو اليوم الأول من الشهر في الإصدار الحالي.");
  }

  return {
    periodMonth: opts.periodMonth,
    branchIds: opts.branchIds.slice(),
    branches: branches,
    mode: opts.mode,
    effectiveDate: opts.effectiveDate,
    effectiveDateObject: effectiveDateObject,
    includeZeroQuantityItems: true,
    confirmationText: "",
    note: opts.note
  };
}

function getMonthlyBaselineResetModeLabelAr_(mode) {
  const labels = {
    from_inventory_count: "من الجرد المعتمد",
    from_latest_snapshot: "من آخر رصيد محفوظ معتمد",
    zero_reset: "رصيد بداية شهر صفري"
  };
  return labels[String(mode || "").trim()] || "";
}

function getMonthlyBaselineResetRequiredConfirmationText_(mode, periodMonth, branchCount) {
  if (String(mode || "").trim() !== "zero_reset") return "";
  return "أفهم أن رصيد بداية الشهر سيكون صفراً لعدد " + Number(branchCount || 0) + " من الفروع لشهر " + String(periodMonth || "").trim();
}

function getCurrentBaselineCatalogItems_(ss) {
  const referenceItems = getReferenceItems_(ss);
  const itemIds = [];
  const itemById = {};
  if (!referenceItems.sheetExists) {
    throw createMonthlyBaselinePreviewError_("تعذر قراءة قائمة المواد الحالية.");
  }
  (referenceItems.itemOrder || []).forEach(function(item) {
    const itemId = String(item && (item.itemId || item.id || item) || "").trim();
    if (!itemId) return;
    if (itemById[itemId]) {
      throw createMonthlyBaselinePreviewError_("توجد مادة مكررة في قائمة المواد الحالية.");
    }
    itemById[itemId] = {
      itemId: itemId,
      nameAr: String(item && item.nameAr || "").trim(),
      baseUnit: String(item && item.baseUnit || "").trim()
    };
    itemIds.push(itemId);
  });
  if (!itemIds.length) {
    throw createMonthlyBaselinePreviewError_("لا توجد مواد حالية لمعاينة رصيد بداية الشهر.");
  }
  return { itemIds: itemIds, itemById: itemById };
}

function getExistingActiveBaselineBranchesForPeriod_(ss, branchIds, periodMonth) {
  const requested = {};
  (branchIds || []).forEach(function(branchId) {
    const id = String(branchId || "").trim();
    if (id) requested[id] = false;
  });
  const sheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Baselines");
  if (!sheet || sheet.getLastRow() < 2) return requested;

  const headerMap = requireHeaderColumns_(sheet, getBalanceBaselineHeaders_().slice(0, 10));
  const targetPeriod = normalizeInventoryPeriodValue_(periodMonth);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  rows.forEach(function(row) {
    const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (!Object.prototype.hasOwnProperty.call(requested, branchId)) return;
    const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
    const rowPeriod = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "period_month"));
    if (status === "active" && rowPeriod === targetPeriod) requested[branchId] = true;
  });
  return requested;
}

function getMonthlyBaselinePreviewSourceDate_(row, headerMap) {
  return parseSheetDate_(getCellByHeader_(row, headerMap, "locked_at")) ||
    parseSheetDate_(getCellByHeader_(row, headerMap, "submitted_at")) ||
    parseSheetDate_(getCellByHeader_(row, headerMap, "updated_at")) ||
    parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
}

function buildCompleteMonthlyBaselineSource_(candidate, sourceRows, sourceHeaderMap, catalog, quantityHeader) {
  const quantities = {};
  const duplicates = {};
  let invalidQuantity = false;
  let invalidBranch = false;
  (sourceRows || []).forEach(function(row) {
    const rowBranchId = String(getCellByHeader_(row, sourceHeaderMap, "branch_id") || candidate.branchId || "").trim();
    if (rowBranchId && rowBranchId !== candidate.branchId) {
      invalidBranch = true;
      return;
    }
    const itemId = String(getCellByHeader_(row, sourceHeaderMap, "item_id") || "").trim();
    if (!catalog.itemById[itemId]) return;
    if (Object.prototype.hasOwnProperty.call(quantities, itemId)) {
      duplicates[itemId] = true;
      return;
    }
    const quantity = parseNumericInput_(getCellByHeader_(row, sourceHeaderMap, quantityHeader));
    if (isNaN(quantity)) {
      invalidQuantity = true;
      return;
    }
    quantities[itemId] = quantity;
  });

  const missingItemIds = catalog.itemIds.filter(function(itemId) {
    return !Object.prototype.hasOwnProperty.call(quantities, itemId);
  });
  const complete = !invalidQuantity && !invalidBranch && Object.keys(duplicates).length === 0 && missingItemIds.length === 0;
  return {
    complete: complete,
    quantities: quantities,
    missingItemCount: missingItemIds.length,
    duplicateItemCount: Object.keys(duplicates).length,
    invalidQuantity: invalidQuantity,
    invalidBranch: invalidBranch
  };
}

function getLatestCompleteInventoryCountBaselineSource_(ss, branchId, effectiveDate, catalog) {
  const countsSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Counts");
  if (!countsSheet || countsSheet.getLastRow() < 2) {
    return { success: false, message: "لا يوجد جرد نهائي مكتمل قبل التاريخ الفعّال." };
  }
  const countsHeaderMap = requireHeaderColumns_(countsSheet, getInventorySchemaRequirements_().Inventory_Counts);
  const countRows = countsSheet.getRange(2, 1, countsSheet.getLastRow() - 1, countsHeaderMap.__lastColumn).getValues();
  const cutoffTime = effectiveDate.getTime();
  const candidates = [];
  const legacyGroups = {};

  countRows.forEach(function(row, index) {
    const status = String(getCellByHeader_(row, countsHeaderMap, "status") || "").trim().toLowerCase();
    if (!isFinalInventoryCountStatus_(status)) return;
    const rowBranchId = String(getCellByHeader_(row, countsHeaderMap, "branch_id") || "").trim();
    if (rowBranchId !== branchId) return;
    const countId = String(getCellByHeader_(row, countsHeaderMap, "count_id") || "").trim();
    if (!countId) return;
    const sourceDate = getMonthlyBaselinePreviewSourceDate_(row, countsHeaderMap);
    if (!sourceDate || sourceDate.getTime() >= cutoffTime) return;
    const itemId = String(getCellByHeader_(row, countsHeaderMap, "item_id") || "").trim();
    const sourcePeriodMonth = normalizeInventoryPeriodValue_(getInventoryCountPeriodFromRow_(row, countsHeaderMap));
    if (!itemId) {
      candidates.push({
        branchId: branchId,
        countId: countId,
        sourceDate: sourceDate,
        sourceTime: sourceDate.getTime(),
        sourcePeriodMonth: sourcePeriodMonth,
        sourceRowIndex: index + 2,
        legacy: false
      });
      return;
    }
    const legacyKey = countId + "|" + branchId;
    if (!legacyGroups[legacyKey]) {
      legacyGroups[legacyKey] = {
        branchId: branchId,
        countId: countId,
        sourceDate: sourceDate,
        sourceTime: sourceDate.getTime(),
        sourcePeriodMonth: sourcePeriodMonth,
        sourceRowIndex: index + 2,
        legacy: true,
        rows: []
      };
    }
    const group = legacyGroups[legacyKey];
    group.rows.push(row);
    if (sourceDate.getTime() > group.sourceTime) {
      group.sourceDate = sourceDate;
      group.sourceTime = sourceDate.getTime();
      group.sourceRowIndex = index + 2;
    }
  });

  Object.keys(legacyGroups).forEach(function(key) {
    candidates.push(legacyGroups[key]);
  });

  const linesByCountId = {};
  const linesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Count_Lines");
  let linesHeaderMap = null;
  if (linesSheet && linesSheet.getLastRow() > 1) {
    linesHeaderMap = requireHeaderColumns_(linesSheet, getInventorySchemaRequirements_().Inventory_Count_Lines);
    const lines = linesSheet.getRange(2, 1, linesSheet.getLastRow() - 1, linesHeaderMap.__lastColumn).getValues();
    lines.forEach(function(row) {
      const countId = String(getCellByHeader_(row, linesHeaderMap, "count_id") || "").trim();
      if (!countId) return;
      if (!linesByCountId[countId]) linesByCountId[countId] = [];
      linesByCountId[countId].push(row);
    });
  }

  candidates.sort(function(a, b) {
    if (a.sourceTime !== b.sourceTime) return b.sourceTime - a.sourceTime;
    return b.sourceRowIndex - a.sourceRowIndex;
  });

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const sourceRows = candidate.legacy ? candidate.rows : (linesByCountId[candidate.countId] || []);
    const sourceHeaderMap = candidate.legacy ? countsHeaderMap : linesHeaderMap;
    if (!sourceHeaderMap || !sourceRows.length) continue;
    const complete = buildCompleteMonthlyBaselineSource_(candidate, sourceRows, sourceHeaderMap, catalog, "normalized_quantity");
    if (!complete.complete) continue;
    return {
      success: true,
      sourceType: "inventory_count",
      sourceLabelAr: "جرد معتمد قبل " + Utilities.formatDate(effectiveDate, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      sourcePeriodMonth: candidate.sourcePeriodMonth,
      sourceDate: Utilities.formatDate(candidate.sourceDate, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      sourceCountId: candidate.countId,
      sourceRunId: "",
      quantities: complete.quantities
    };
  }

  return { success: false, message: "لا يوجد جرد نهائي مكتمل يغطي جميع المواد الحالية قبل التاريخ الفعّال." };
}

function getLatestTrustedSnapshotBaselineSource_(ss, branchId, effectiveDate, catalog) {
  const balancesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  if (!balancesSheet || balancesSheet.getLastRow() < 2) {
    return { success: false, message: "لا يوجد رصيد محفوظ مكتمل ومعتمد قبل التاريخ الفعّال." };
  }
  const headerMap = requireHeaderColumns_(balancesSheet, getInventorySchemaRequirements_().Inventory_Balances);
  const rows = balancesSheet.getRange(2, 1, balancesSheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
  const runMap = getSuccessfulBalanceRunMap_(ss);
  const cutoffTime = effectiveDate.getTime();
  const groups = {};

  rows.forEach(function(row, index) {
    const rowBranchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (rowBranchId !== branchId) return;
    const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
    const periodMonth = normalizeInventoryPeriodValue_(getCellByHeader_(row, headerMap, "period_month"));
    if (!runId || !periodMonth) return;
    const runMeta = getSuccessfulBalanceRunForBranchPeriod_(runMap, runId, branchId, periodMonth);
    if (!runMeta) return;
    const proofDate = runMeta.finishedAt || runMeta.startedAt;
    if (proofDate && proofDate.getTime() >= cutoffTime) return;
    const calculatedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "calculated_at"));
    if (!calculatedAt || calculatedAt.getTime() >= cutoffTime) return;

    const key = getBalanceRunBranchPeriodKey_(runId, branchId, periodMonth);
    if (!groups[key]) {
      groups[key] = {
        branchId: branchId,
        runId: runId,
        periodMonth: periodMonth,
        runMeta: runMeta,
        rows: [],
        sourceDate: calculatedAt,
        sourceTime: calculatedAt.getTime(),
        maxRowIndex: index + 2
      };
    }
    const group = groups[key];
    group.rows.push(row);
    if (calculatedAt.getTime() >= group.sourceTime) {
      group.sourceDate = calculatedAt;
      group.sourceTime = calculatedAt.getTime();
    }
    if (index + 2 > group.maxRowIndex) group.maxRowIndex = index + 2;
  });

  const candidates = Object.keys(groups).map(function(key) { return groups[key]; });
  candidates.sort(function(a, b) {
    if (a.sourceTime !== b.sourceTime) return b.sourceTime - a.sourceTime;
    return b.maxRowIndex - a.maxRowIndex;
  });

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const expectedItems = Number(candidate.runMeta && candidate.runMeta.itemsProcessed || 0);
    if (expectedItems > 0 && candidate.rows.length !== expectedItems) continue;
    const complete = buildCompleteMonthlyBaselineSource_(candidate, candidate.rows, headerMap, catalog, "balance");
    if (!complete.complete) continue;
    return {
      success: true,
      sourceType: "saved_snapshot",
      sourceLabelAr: "رصيد محفوظ معتمد قبل " + Utilities.formatDate(effectiveDate, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      sourcePeriodMonth: candidate.periodMonth,
      sourceDate: Utilities.formatDate(candidate.sourceDate, Session.getScriptTimeZone(), "yyyy-MM-dd"),
      sourceCountId: "",
      sourceRunId: candidate.runId,
      quantities: complete.quantities
    };
  }

  return { success: false, message: "لا يوجد رصيد محفوظ مكتمل ومرتبط بتشغيل ناجح قبل التاريخ الفعّال." };
}

function buildZeroResetBaselinePreviewSource_(catalog) {
  const quantities = {};
  catalog.itemIds.forEach(function(itemId) {
    quantities[itemId] = 0;
  });
  return {
    success: true,
    sourceType: "zero",
    sourceLabelAr: "رصيد بداية شهر صفري",
    sourcePeriodMonth: "",
    sourceDate: "",
    sourceCountId: "",
    sourceRunId: "",
    quantities: quantities
  };
}

function buildMonthlyBaselinePreviewForBranch_(ss, branch, options, catalog, existingBaselineByBranch) {
  const branchId = String(branch && branch.id || "").trim();
  const blockReasons = [];
  const warnings = [];
  if (existingBaselineByBranch[branchId] === true) {
    blockReasons.push("يوجد رصيد بداية شهر فعّال لهذا الفرع والشهر.");
  }

  let source;
  if (options.mode === "from_inventory_count") {
    source = getLatestCompleteInventoryCountBaselineSource_(ss, branchId, options.effectiveDateObject, catalog);
  } else if (options.mode === "from_latest_snapshot") {
    source = getLatestTrustedSnapshotBaselineSource_(ss, branchId, options.effectiveDateObject, catalog);
  } else {
    source = buildZeroResetBaselinePreviewSource_(catalog);
  }
  if (!source || !source.success) {
    blockReasons.push(source && source.message ? source.message : "تعذر تحديد مصدر رصيد بداية الشهر لهذا الفرع.");
  }

  let positiveItemCount = 0;
  let zeroItemCount = 0;
  let negativeItemCount = 0;
  let missingItemCount = 0;
  const quantities = source && source.quantities ? source.quantities : {};
  catalog.itemIds.forEach(function(itemId) {
    if (!Object.prototype.hasOwnProperty.call(quantities, itemId)) {
      missingItemCount++;
      return;
    }
    const quantity = Number(quantities[itemId]);
    if (quantity > 0) positiveItemCount++;
    else if (quantity < 0) negativeItemCount++;
    else zeroItemCount++;
  });
  if (negativeItemCount > 0) {
    warnings.push("يحتوي المصدر على أرصدة سالبة ويجب مراجعتها قبل الإنشاء.");
  }

  const blocked = blockReasons.length > 0;
  return {
    branchId: branchId,
    branchName: String(branch && (branch.nameAr || branch.name) || branchId).trim(),
    canCreate: !blocked,
    blocked: blocked,
    blockReasons: blockReasons,
    sourceType: source && source.sourceType || "",
    sourceLabelAr: source && source.sourceLabelAr || "",
    sourcePeriodMonth: source && source.sourcePeriodMonth || "",
    sourceDate: source && source.sourceDate || "",
    sourceCountId: source && source.sourceCountId || "",
    sourceRunId: source && source.sourceRunId || "",
    itemCount: catalog.itemIds.length,
    positiveItemCount: positiveItemCount,
    zeroItemCount: zeroItemCount,
    negativeItemCount: negativeItemCount,
    missingItemCount: missingItemCount,
    plannedRows: source && source.success ? catalog.itemIds.length : 0,
    warnings: warnings,
    effectiveCutoffExplanationAr: "سيتم احتساب الحركات من تاريخ " + options.effectiveDate + " وما بعده فقط."
  };
}

function buildMonthlyBaselinePreviewSummary_(branches, catalogItemCount) {
  const branchRows = Array.isArray(branches) ? branches : [];
  let plannedRows = 0;
  let blockedBranchCount = 0;
  let warningCount = 0;
  branchRows.forEach(function(branch) {
    plannedRows += Number(branch && branch.plannedRows || 0);
    if (branch && branch.blocked) blockedBranchCount++;
    warningCount += branch && Array.isArray(branch.warnings) ? branch.warnings.length : 0;
  });
  return {
    branchCount: branchRows.length,
    itemCount: Number(catalogItemCount || 0),
    plannedRows: plannedRows,
    blockedBranchCount: blockedBranchCount,
    warningCount: warningCount
  };
}

function getMonthlyBaselineResetMutationAction_(options) {
  const opts = options || {};
  const branchIds = (opts.branchIds || []).map(function(branchId) {
    return String(branchId || "").trim();
  }).sort();
  return [
    "execute_monthly_balance_baseline_reset",
    String(opts.periodMonth || "").trim(),
    String(opts.mode || "").trim(),
    String(opts.effectiveDate || "").trim(),
    branchIds.join(",")
  ].join("|");
}

function getMonthlyBaselineResetSourceForExecution_(ss, branchId, options, catalog) {
  if (options.mode === "from_inventory_count") {
    return getLatestCompleteInventoryCountBaselineSource_(ss, branchId, options.effectiveDateObject, catalog);
  }
  if (options.mode === "from_latest_snapshot") {
    return getLatestTrustedSnapshotBaselineSource_(ss, branchId, options.effectiveDateObject, catalog);
  }
  return buildZeroResetBaselinePreviewSource_(catalog);
}

function previewMonthlyBalanceBaselineReset(sessionToken, options) {
  const permissionMessage = "هذه المعاينة متاحة للمالك فقط.";
  let ss;
  let user;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    user = requireOwner_(ss, sessionToken);
  } catch (authorizationError) {
    console.error("previewMonthlyBalanceBaselineReset authorization failed", {
      message: authorizationError && authorizationError.message ? String(authorizationError.message) : String(authorizationError || "")
    });
    return { success: false, canCreate: false, message: permissionMessage, warnings: [], errors: [permissionMessage] };
  }

  try {
    const normalized = normalizeMonthlyBalanceBaselineResetOptions_(options);
    const validated = validateMonthlyBaselineResetOptions_(ss, normalized);
    const catalog = getCurrentBaselineCatalogItems_(ss);
    const existingBaselineByBranch = getExistingActiveBaselineBranchesForPeriod_(ss, validated.branchIds, validated.periodMonth);
    const branchPreviews = validated.branches.map(function(branch) {
      return buildMonthlyBaselinePreviewForBranch_(ss, branch, validated, catalog, existingBaselineByBranch);
    });
    const summary = buildMonthlyBaselinePreviewSummary_(branchPreviews, catalog.itemIds.length);
    const warnings = [];
    branchPreviews.forEach(function(branch) {
      (branch.warnings || []).forEach(function(warning) {
        warnings.push((branch.branchName || branch.branchId) + ": " + warning);
      });
    });
    return {
      success: true,
      canCreate: summary.blockedBranchCount === 0,
      previewToken: summary.blockedBranchCount === 0
        ? createMutationToken_(user.employeeNumber, getMonthlyBaselineResetMutationAction_(validated), 900)
        : "",
      mode: validated.mode,
      modeLabelAr: getMonthlyBaselineResetModeLabelAr_(validated.mode),
      periodMonth: validated.periodMonth,
      effectiveDate: validated.effectiveDate,
      includeZeroQuantityItems: true,
      dangerous: validated.mode === "zero_reset",
      requiredConfirmationText: getMonthlyBaselineResetRequiredConfirmationText_(validated.mode, validated.periodMonth, validated.branchIds.length),
      summary: summary,
      branches: branchPreviews,
      warnings: warnings,
      errors: []
    };
  } catch (e) {
    console.error("previewMonthlyBalanceBaselineReset failed", {
      message: e && e.message ? String(e.message) : String(e || ""),
      stack: e && e.stack ? String(e.stack) : ""
    });
    const safeMessage = e && e.monthlyBaselinePreviewSafe
      ? String(e.message)
      : "تعذر تجهيز معاينة رصيد بداية الشهر حالياً. تحقق من البيانات وحاول مرة أخرى.";
    return { success: false, canCreate: false, message: safeMessage, warnings: [], errors: [safeMessage] };
  }
}

function executeMonthlyBalanceBaselineReset(sessionToken, options, previewToken) {
  const permissionMessage = "إنشاء رصيد بداية الشهر متاح للمالك فقط.";
  const duplicateMessage = "يوجد رصيد بداية شهر فعّال أو قيد الإنشاء لأحد الفروع المحددة في نفس الشهر.";
  const committedWarning = "تم تفعيل رصيد بداية الشهر، لكن تعذر إكمال سجل التدقيق. لا تعِد تنفيذ العملية.";
  let ss;
  let user;
  let lock = null;
  let lockAcquired = false;
  let committed = false;
  let committedBatchId = "";
  let committedValidated = null;
  let committedExpectation = null;
  let reconciled = false;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
    user = requireOwner_(ss, sessionToken);
  } catch (authorizationError) {
    console.error("executeMonthlyBalanceBaselineReset authorization failed", {
      message: authorizationError && authorizationError.message ? String(authorizationError.message) : String(authorizationError || "")
    });
    return { success: false, committed: false, message: permissionMessage };
  }

  try {
    const normalized = normalizeMonthlyBalanceBaselineResetOptions_(options);
    const validated = validateMonthlyBaselineResetOptions_(ss, normalized);
    committedValidated = validated;
    const requiredConfirmationText = getMonthlyBaselineResetRequiredConfirmationText_(validated.mode, validated.periodMonth, validated.branchIds.length);
    if (validated.mode === "zero_reset" && normalized.confirmationText !== requiredConfirmationText) {
      return { success: false, committed: false, message: "اكتب نص التأكيد الظاهر كاملاً قبل إنشاء الرصيد الصفري." };
    }

    const earlyOperationIdentity = buildMonthlyBaselineOperationIdentity_(validated, user.employeeNumber, previewToken);
    const existingSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Baselines");
    if (existingSheet && existingSheet.getLastRow() > 1) {
      const existingHeaderMap = getHeaderMap_(existingSheet);
      const durableHeadersPresent = [
        "batch_id", "request_digest", "preview_token_digest", "baseline_mode",
        "expected_row_count", "expected_branch_digest", "expected_item_digest", "expected_manifest_digest"
      ].every(function(headerName) { return getHeaderIndex_(existingHeaderMap, headerName) > 0; });
      if (durableHeadersPresent) {
        const existingSchema = { sheet: existingSheet, headerMap: existingHeaderMap };
        const earlyBatchId = findMonthlyBaselineBatchIdByOperation_(existingSchema, earlyOperationIdentity.previewTokenDigest);
        if (earlyBatchId) {
          const earlyInspection = inspectMonthlyBaselineBatch_(existingSchema, earlyBatchId, earlyOperationIdentity);
          if (earlyInspection.active && earlyInspection.metadataMatches) {
            committed = true;
            committedBatchId = earlyBatchId;
            committedExpectation = {
              itemIds: earlyInspection.actualItemIds,
              expectedRowCount: earlyInspection.expectedRowCount
            };
            return buildMonthlyBaselineCommittedResponse_(validated, committedExpectation, earlyBatchId, true, true, "");
          }
        }
      }
    }

    const catalog = getCurrentBaselineCatalogItems_(ss);
    const branchPlans = validated.branches.map(function(branch) {
      const branchId = String(branch && branch.id || "").trim();
      const source = getMonthlyBaselineResetSourceForExecution_(ss, branchId, validated, catalog);
      return { branch: branch, branchId: branchId, source: source };
    });
    const preflightBlocked = branchPlans.some(function(plan) {
      return !plan.source || !plan.source.success;
    });
    if (preflightBlocked) {
      return { success: false, committed: false, message: "تغيرت بيانات المعاينة أو أصبح أحد الفروع غير جاهز. أعد المعاينة قبل الإنشاء." };
    }
    let expectation = buildMonthlyBaselineExpectedBatch_(validated, catalog, branchPlans, user.employeeNumber, previewToken);
    committedExpectation = expectation;

    lock = LockService.getScriptLock();
    lockAcquired = lock.tryLock(15000);
    if (!lockAcquired) {
      return { success: false, committed: false, message: "النظام مشغول حالياً. أعد المعاينة ثم حاول مرة أخرى." };
    }

    validated.branchIds.forEach(function(branchId) { requireActiveBranch_(ss, branchId); });
    const schema = ensureBalanceBaselinesSchema_(ss);
    const existingBatchId = findMonthlyBaselineBatchIdByOperation_(schema, expectation.previewTokenDigest);
    let batchId = existingBatchId;
    const operationIdentity = {
      requestDigest: expectation.requestDigest,
      previewTokenDigest: expectation.previewTokenDigest,
      mode: validated.mode,
      periodMonth: validated.periodMonth,
      effectiveDate: validated.effectiveDate,
      ownerEmployeeNumber: user.employeeNumber
    };
    let inspection = existingBatchId ? inspectMonthlyBaselineBatch_(schema, existingBatchId, operationIdentity) : null;

    if (existingBatchId) {
      if (!inspection.metadataMatches) {
        return { success: false, committed: false, message: "تعذر مطابقة العملية السابقة بشكل آمن. لا تعِد التنفيذ قبل مراجعة المالك." };
      }
      if (inspection.active) {
        committed = true;
        committedBatchId = existingBatchId;
        return buildMonthlyBaselineCommittedResponse_(validated, expectation, existingBatchId, true, true, "");
      }
    }

    const lockedBranchPlans = validated.branches.map(function(branch) {
      const branchId = String(branch && branch.id || "").trim();
      const source = getMonthlyBaselineResetSourceForExecution_(ss, branchId, validated, catalog);
      if (!source || !source.success) throw new Error("baseline_source_changed_under_lock");
      return { branch: branch, branchId: branchId, source: source };
    });
    const lockedExpectation = buildMonthlyBaselineExpectedBatch_(validated, catalog, lockedBranchPlans, user.employeeNumber, previewToken);
    if (lockedExpectation.expectedManifestDigest !== expectation.expectedManifestDigest) {
      return { success: false, committed: false, message: "تغير مصدر رصيد البداية أثناء التنفيذ. أعد المعاينة قبل المحاولة من جديد." };
    }
    expectation = lockedExpectation;
    committedExpectation = expectation;

    if (existingBatchId) {
      inspection = inspectMonthlyBaselineBatch_(schema, existingBatchId, expectation);
      if (inspection.recoverablePending) {
        const recoveredRows = buildMonthlyBaselineRows_(schema, existingBatchId, validated, expectation, user.employeeNumber, new Date(), inspection.missingRows);
        if (recoveredRows.length) {
          schema.sheet.getRange(schema.sheet.getLastRow() + 1, 1, recoveredRows.length, schema.headerMap.__lastColumn).setValues(recoveredRows);
          SpreadsheetApp.flush();
        }
        inspection = inspectMonthlyBaselineBatch_(schema, existingBatchId, expectation);
        reconciled = true;
      } else if (inspection.pending || inspection.mixedStatus) {
        reconciled = true;
      } else {
        return { success: false, committed: false, message: "وجدت عملية معلقة غير مكتملة ولا يمكن تفعيلها تلقائياً بأمان. راجع المالك قبل إعادة التنفيذ." };
      }
      if (!inspection.complete || (!inspection.pending && !inspection.mixedStatus)) {
        return { success: false, committed: false, message: "تعذر استعادة العملية المعلقة بشكل كامل وآمن. لم يتم اعتمادها كرصد فعّال." };
      }
    } else {
      if (hasConflictingMonthlyBaselineBatch_(schema, validated.branchIds, validated.periodMonth, "")) {
        return { success: false, committed: false, message: duplicateMessage };
      }
      consumeMutationToken_(previewToken, user.employeeNumber, getMonthlyBaselineResetMutationAction_(validated));
      const now = new Date();
      batchId = "MONTHLY-BASELINE-" + validated.periodMonth + "-" + now.getTime() + "-" + Utilities.getUuid().slice(0, 8);
      const rows = buildMonthlyBaselineRows_(schema, batchId, validated, expectation, user.employeeNumber, now);
      if (!rows.length) throw new Error("baseline_rows_empty");
      schema.sheet.getRange(schema.sheet.getLastRow() + 1, 1, rows.length, schema.headerMap.__lastColumn).setValues(rows);
      SpreadsheetApp.flush();
      inspection = inspectMonthlyBaselineBatch_(schema, batchId, expectation);
      if (!inspection.complete || !inspection.pending) throw new Error("baseline_pending_verification_failed");
    }

    const activeInspection = activateVerifiedMonthlyBaselineBatch_(schema, batchId, expectation);
    if (!activeInspection.active) throw new Error("baseline_activation_verification_failed");
    committed = true;
    committedBatchId = batchId;

    const logsSheet = getSheetByNameCaseInsensitive_(ss, "Logs");
    const auditResult = tryLogCommittedAction_("MONTHLY_BASELINE_ACTIVATED", user.employeeNumber, {
      entityId: batchId,
      entityType: "Inventory_Balance_Baselines",
      periodMonth: validated.periodMonth,
      effectiveDate: validated.effectiveDate,
      mode: validated.mode,
      branchIds: validated.branchIds,
      itemCount: expectation.itemIds.length,
      rowCount: expectation.expectedRowCount,
      recovered: reconciled,
      sources: expectation.sourceAudit,
      automaticRecalculation: false
    }, logsSheet, new Date());
    return buildMonthlyBaselineCommittedResponse_(
      validated,
      expectation,
      batchId,
      reconciled,
      reconciled,
      auditResult && auditResult.success ? "" : committedWarning
    );
  } catch (e) {
    console.error("executeMonthlyBalanceBaselineReset failed", {
      message: e && e.message ? String(e.message) : String(e || ""),
      stack: e && e.stack ? String(e.stack) : ""
    });
    if (committed && committedBatchId && committedValidated && committedExpectation) {
      return buildMonthlyBaselineCommittedResponse_(
        committedValidated,
        committedExpectation,
        committedBatchId,
        reconciled,
        reconciled,
        committedWarning
      );
    }
    const rawMessage = e && e.message ? String(e.message) : "";
    const safeMessages = [
      "تم إرسال العملية مسبقاً أو انتهت صلاحيتها. الرجاء تحديث الشاشة والمحاولة من جديد.",
      duplicateMessage,
      "اكتب نص التأكيد الظاهر كاملاً قبل إنشاء الرصيد الصفري."
    ];
    return {
      success: false,
      committed: false,
      message: safeMessages.indexOf(rawMessage) !== -1
        ? rawMessage
        : "تعذر إنشاء رصيد بداية الشهر بأمان. بقيت أي كتابة غير مكتملة غير فعّالة وتحتاج مراجعة المالك."
    };
  } finally {
    if (lockAcquired && lock) lock.releaseLock();
  }
}

function createZeroBalanceBaselineForBranch(branchId, periodMonth, effectiveDate, sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    requireOwner_(ss, sessionToken);
    return {
      success: false,
      committed: false,
      message: "استخدم معاينة رصيد بداية الشهر ثم نفّذ العملية من شاشة إعدادات الفروع."
    };
  } catch (e) {
    console.error("createZeroBalanceBaselineForBranch failed", {
      message: e && e.message ? String(e.message) : String(e || "")
    });
    return {
      success: false,
      committed: false,
      message: "هذه العملية متاحة للمالك فقط. استخدم معاينة رصيد بداية الشهر من شاشة إعدادات الفروع."
    };
  }
}

function buildBalanceSnapshotRowsForPeriodR01Read_(ss, options) {
  const opts = options || {};
  const targetBranchId = String(opts.branchId || "").trim();
  const runtimeOptions = {
    startedAtMs: Number(opts.startedAtMs || 0),
    runtimeBudgetMs: Number(opts.runtimeBudgetMs || 0)
  };
  const useBoundedSourceReads = !!(opts.boundedSourceReads && targetBranchId);
  const periodInfo = getBalancePeriodBounds_(opts.periodMonth);
  const baselineMap = getActiveBalanceBaselineMapForBranchPeriod_(ss, targetBranchId, periodInfo.periodMonth);
  if (targetBranchId) {
    requireActiveBranch_(ss, targetBranchId);
  }

  const balancesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
  const balancesHeaderMap = requireHeaderColumns_(balancesSheet, getInventorySchemaRequirements_().Inventory_Balances);

  const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
  const pHeader = purchasesSheet ? requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases) : null;
  assertBalanceRuntimeBudget_(runtimeOptions.startedAtMs, "Purchases read", runtimeOptions.runtimeBudgetMs);
  let pData;
  if (purchasesSheet) {
    const pColumns = [
      "branch",
      "item_id",
      "normalized_quantity",
      "created_at"
    ];
    pData = useBoundedSourceReads
      ? getProjectedSheetRowsByRowNumbersAndHeaders_(purchasesSheet, pHeader, pColumns, getPurchaseBalanceCandidateRowNumbers_(purchasesSheet, pHeader, targetBranchId))
      : getProjectedSheetRowsByHeaders_(purchasesSheet, pHeader, pColumns);
  } else {
    pData = [];
  }

  const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  const tHeader = transfersSheet ? requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers) : null;
  assertBalanceRuntimeBudget_(runtimeOptions.startedAtMs, "Transfers read", runtimeOptions.runtimeBudgetMs);
  let transferUsersIndex = null;
  let tData;
  if (transfersSheet) {
    const tColumns = [
      "transfer_id",
      "branch",
      "source_branch",
      "item_id",
      "normalized_quantity",
      "received_normalized_quantity",
      "missing_qty",
      "status",
      "created_by",
      "created_at",
      "received_at"
    ];
    transferUsersIndex = getUsersIndex_(ss);
    tData = useBoundedSourceReads
      ? getProjectedSheetRowsByRowNumbersAndHeaders_(transfersSheet, tHeader, tColumns, getTransferBalanceCandidateRowNumbers_(transfersSheet, tHeader, targetBranchId, transferUsersIndex))
      : getProjectedSheetRowsByHeaders_(transfersSheet, tHeader, tColumns);
  } else {
    tData = [];
  }

  const branchTotals = {};
  function getBranchItemTotals(bId, iId) {
    if (!branchTotals[bId]) branchTotals[bId] = {};
    if (!branchTotals[bId][iId]) branchTotals[bId][iId] = { in: 0, out: 0, start: 0 };
    return branchTotals[bId][iId];
  }

  assertBalanceRuntimeBudget_(runtimeOptions.startedAtMs, "Starting inventory counts", runtimeOptions.runtimeBudgetMs);
  const startingCounts = getLatestInventoryCountsBefore_(ss, targetBranchId ? [targetBranchId] : null, null, periodInfo.periodStart, runtimeOptions);
  Object.keys(startingCounts).forEach(function(bId) {
    Object.keys(startingCounts[bId]).forEach(function(iId) {
      getBranchItemTotals(bId, iId).start = startingCounts[bId][iId].normalizedQuantity;
    });
  });
  Object.keys(baselineMap.byBranch).forEach(function(bId) {
    const branchBaseline = baselineMap.byBranch[bId];
    Object.keys(branchBaseline.items).forEach(function(iId) {
      getBranchItemTotals(bId, iId).start = branchBaseline.items[iId];
    });
  });

  let legacyReceivedFallbackWarnings = 0;
  if (pData && pData.length > 1) {
    for (let i = 1; i < pData.length; i++) {
      if (i % 100 === 0) assertBalanceRuntimeBudget_(runtimeOptions.startedAtMs, "Purchases scan", runtimeOptions.runtimeBudgetMs);
      const row = pData[i];
      const bId = String(getCellByHeader_(row, pHeader, "branch")).trim();
      if (targetBranchId && bId !== targetBranchId) continue;

      const date = parseSheetDate_(getCellByHeader_(row, pHeader, "created_at"));
      const movementStart = getBaselineEffectiveDateForBranchPeriod_(baselineMap, bId, periodInfo.periodStart);
      if (!date || date < movementStart || date > periodInfo.periodEnd) continue;

      const iId = String(getCellByHeader_(row, pHeader, "item_id")).trim();
      const qty = parseFloat(getCellByHeader_(row, pHeader, "normalized_quantity")) || 0;
      getBranchItemTotals(bId, iId).in += qty;
    }
  }

  if (tData && tData.length > 1) {
    transferUsersIndex = transferUsersIndex || getUsersIndex_(ss);
    for (let i = 1; i < tData.length; i++) {
      if (i % 100 === 0) assertBalanceRuntimeBudget_(runtimeOptions.startedAtMs, "Transfers scan", runtimeOptions.runtimeBudgetMs);
      const row = tData[i];
      const bIdTarget = String(getCellByHeader_(row, tHeader, "branch")).trim();
      const storedSource = String(getCellByHeader_(row, tHeader, "source_branch") || "").trim();
      const durableTransfer = /^TRF-inv-[a-f0-9]{32}$/.test(String(getCellByHeader_(row, tHeader, "transfer_id") || ""));
      const bIdSource = durableTransfer ? storedSource : resolveTransferSourceBranchForMigration_(
        transferUsersIndex,
        getCellByHeader_(row, tHeader, "created_by"),
        storedSource
      );
      if (targetBranchId && bIdTarget !== targetBranchId && bIdSource !== targetBranchId) continue;

      const createdDate = parseSheetDate_(getCellByHeader_(row, tHeader, "created_at"));
      // Incoming stock is effective when the manager received it, not when it
      // was shipped; legacy rows without received_at fall back to created_at.
      const receivedAtDate = parseSheetDate_(getCellByHeader_(row, tHeader, "received_at"));
      const receiptDate = receivedAtDate || createdDate;
      const createdInPeriod = !!createdDate && createdDate >= periodInfo.periodStart && createdDate <= periodInfo.periodEnd;
      const receiptInPeriod = !!receiptDate && receiptDate >= periodInfo.periodStart && receiptDate <= periodInfo.periodEnd;
      if (!createdInPeriod && !receiptInPeriod) continue;

      const status = String(getCellByHeader_(row, tHeader, "status")).trim().toLowerCase();

      const iId = String(getCellByHeader_(row, tHeader, "item_id")).trim();
      const qty = parseFloat(getCellByHeader_(row, tHeader, "normalized_quantity")) || 0;
      const missing = parseFloat(getCellByHeader_(row, tHeader, "missing_qty")) || 0;

      const sourceMovementStart = getBaselineEffectiveDateForBranchPeriod_(baselineMap, bIdSource, periodInfo.periodStart);
      if (createdInPeriod && createdDate >= sourceMovementStart && bIdSource !== "DISTRIBUTOR" && (!targetBranchId || bIdSource === targetBranchId)) {
        getBranchItemTotals(bIdSource, iId).out += qty;
      }

      if (status === "approved" || status === "missing") {
        const targetMovementStart = getBaselineEffectiveDateForBranchPeriod_(baselineMap, bIdTarget, periodInfo.periodStart);
        if (receiptInPeriod && receiptDate >= targetMovementStart && (!targetBranchId || bIdTarget === targetBranchId)) {
          const receivedNormalizedQty = getReceivedNormalizedQuantityForBalance_(row, tHeader);
          if (receivedNormalizedQty !== null) {
            getBranchItemTotals(bIdTarget, iId).in += receivedNormalizedQty;
          } else if (status === "approved") {
            getBranchItemTotals(bIdTarget, iId).in += qty;
          } else {
            getBranchItemTotals(bIdTarget, iId).in += Math.max(0, qty - missing);
            legacyReceivedFallbackWarnings++;
          }
        }
      }
    }
  }

  const rowsToAppend = [];
  const now = opts.calculatedAt || new Date();
  let missingStartingCountWarnings = 0;
  Object.keys(branchTotals).forEach(function(bId) {
    Object.keys(branchTotals[bId]).forEach(function(iId) {
      const totals = branchTotals[bId][iId];
      const branchBaseline = baselineMap.byBranch[bId];
      const hasBaselineStart = !!(branchBaseline && Object.prototype.hasOwnProperty.call(branchBaseline.items, iId));
      if (!hasBaselineStart && (!startingCounts[bId] || !startingCounts[bId][iId])) {
        missingStartingCountWarnings++;
      }
      rowsToAppend.push(buildRowByHeaders_(balancesHeaderMap, {
        snapshot_id: "SNAP-" + bId + "-" + periodInfo.periodMonth + "-" + now.getTime(),
        branch_id: bId,
        item_id: iId,
        period_month: periodInfo.periodMonth,
        period_start: periodInfo.periodStart,
        period_end: periodInfo.periodEnd,
        starting_balance: totals.start,
        total_in: totals.in,
        total_out: totals.out,
        balance: totals.start + totals.in - totals.out,
        calculated_at: now,
        calculated_by: opts.createdBy || "",
        run_id: opts.runId || ""
      }));
    });
  });

  const branchSeen = {};
  const branchItemCounts = {};
  const itemSeen = {};
  Object.keys(branchTotals).forEach(function(bId) {
    branchSeen[bId] = true;
    branchItemCounts[bId] = Object.keys(branchTotals[bId]).length;
    Object.keys(branchTotals[bId]).forEach(function(iId) {
      itemSeen[iId] = true;
    });
  });

  return {
    periodMonth: periodInfo.periodMonth,
    periodStart: periodInfo.periodStart,
    periodEnd: periodInfo.periodEnd,
    rowsToAppend: rowsToAppend,
    rowWidth: balancesHeaderMap.__lastColumn,
    branchesProcessed: targetBranchId ? 1 : Object.keys(branchSeen).length,
    branchIdsProcessed: Object.keys(branchSeen),
    branchItemCounts: branchItemCounts,
    itemsProcessed: Object.keys(itemSeen).length,
    calculatedAt: now,
    missingStartingCountWarnings: missingStartingCountWarnings,
    legacyReceivedFallbackWarnings: legacyReceivedFallbackWarnings
  };
}

var BALANCE_SOURCE_VERSION_PROPERTY = "BALANCE_SOURCE_VERSION";

function getBalanceSourceVersion_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(BALANCE_SOURCE_VERSION_PROPERTY) || "0");
  } catch (e) {
    console.error("getBalanceSourceVersion_ failed: " + e.toString());
    return null;
  }
}

function bumpBalanceSourceVersion_() {
  // Must run inside the same ScriptLock as the balance-input sheet write and
  // BEFORE that write: a bump without a write only costs one recompute, but a
  // write without a bump could hide committed data from a trusted snapshot.
  // A bump failure therefore throws so the caller aborts before writing.
  const props = PropertiesService.getScriptProperties();
  const current = Number(props.getProperty(BALANCE_SOURCE_VERSION_PROPERTY) || "0");
  const next = (isFinite(current) ? current : 0) + 1;
  props.setProperty(BALANCE_SOURCE_VERSION_PROPERTY, String(next));
  return next;
}

function appendBalanceSkipRunLog_(ss, runId, triggerType, targetBranchId, targetPeriodMonth, startedAt, createdBy, status, message) {
  let skippedPeriodInfo = { periodMonth: targetPeriodMonth, periodStart: "", periodEnd: "" };
  try { skippedPeriodInfo = getBalancePeriodBounds_(targetPeriodMonth); } catch (periodError) {}
  appendBalanceRunLogWithLock_(ss, {
    run_id: runId,
    trigger_type: triggerType,
    period_start: skippedPeriodInfo.periodStart,
    period_end: skippedPeriodInfo.periodEnd,
    period_month: skippedPeriodInfo.periodMonth || targetPeriodMonth,
    branch_id: targetBranchId,
    status: status,
    branches_processed: 0,
    items_processed: 0,
    started_at: startedAt,
    finished_at: new Date(),
    created_by: createdBy,
    message: message
  }, 1000);
}

function calculateBalanceSnapshotForPeriodInternal_(options) {
  const opts = options || {};
  const ss = opts.ss || SpreadsheetApp.getActiveSpreadsheet();
  const runId = opts.runId || createBalanceRunId_();
  const startedAt = opts.startedAt || new Date();
  const triggerType = String(opts.triggerType || "manual_owner").trim() || "manual_owner";
  const createdBy = String(opts.createdBy || "").trim() || "unknown";
  const targetBranchId = String(opts.branchId || "").trim();
  const runtimeStartedAtMs = Number(opts.startedAtMs || (new Date()).getTime());
  const runtimeBudgetMs = Number(opts.runtimeBudgetMs || 0);
  let lock = null;
  let lockAcquired = false;
  let periodStart = "";
  let periodEnd = "";
  let targetPeriodMonth = String(opts.periodMonth || "").trim();
  let branchesProcessed = targetBranchId ? 1 : 0;
  let itemsProcessed = 0;

  try {
    // Optimistic concurrency: heavy source reads and calculation run OUTSIDE
    // the lock. The short lock only revalidates the balance source version and
    // performs the final trusted-snapshot commit, so business writes are never
    // blocked for the duration of the calculation, and any write that lands
    // mid-calculation invalidates the snapshot instead of vanishing from it.
    lock = LockService.getScriptLock();
    const waitMs = opts.lockWaitMs === undefined ? 30000 : Number(opts.lockWaitMs);
    let snapshot = null;
    let committedVersionMatch = false;
    const maxCalculationAttempts = 2;

    for (let attempt = 1; attempt <= maxCalculationAttempts; attempt++) {
      const sourceVersionAtRead = getBalanceSourceVersion_();

      snapshot = buildBalanceSnapshotRowsForPeriod_(ss, {
        periodMonth: String(opts.periodMonth || "").trim(),
        branchId: targetBranchId,
        createdBy: createdBy,
        runId: runId,
        calculatedAt: new Date(),
        startedAtMs: runtimeStartedAtMs,
        runtimeBudgetMs: runtimeBudgetMs,
        boundedSourceReads: targetBranchId && isOwnerManualBalanceTrigger_(triggerType)
      });
      periodStart = snapshot.periodStart;
      periodEnd = snapshot.periodEnd;
      targetPeriodMonth = snapshot.periodMonth;
      branchesProcessed = snapshot.branchesProcessed;
      itemsProcessed = snapshot.itemsProcessed;

      lockAcquired = waitMs > 0 ? lock.tryLock(waitMs) : lock.tryLock(0);
      if (!lockAcquired) {
        appendBalanceSkipRunLog_(ss, runId, triggerType, targetBranchId, targetPeriodMonth, startedAt, createdBy,
          "Skipped_Lock_Busy", "تم تخطي حساب الرصيد لأن قفل النظام مشغول.");
        return { success: false, skipped: true, status: "Skipped_Lock_Busy", runId: runId, branchId: targetBranchId, message: "تم تخطي حساب الرصيد لأن قفل النظام مشغول." };
      }

      const sourceVersionAtCommit = getBalanceSourceVersion_();
      // Unreadable versions fail closed: no trusted snapshot may be committed
      // from sources whose stability cannot be verified.
      if (sourceVersionAtRead !== null && sourceVersionAtCommit !== null && sourceVersionAtRead === sourceVersionAtCommit) {
        committedVersionMatch = true;
        break;
      }

      lock.releaseLock();
      lockAcquired = false;
      // The recompute must not reuse this execution's cached sheet reads, or
      // the retry would rebuild the same stale snapshot it just invalidated.
      SpreadsheetApp.flush();
      if (attempt >= maxCalculationAttempts) {
        appendBalanceSkipRunLog_(ss, runId, triggerType, targetBranchId, targetPeriodMonth, startedAt, createdBy,
          "Skipped_Source_Changed", "تم تخطي حساب الرصيد لأن بيانات الحركة تغيّرت أثناء الحساب. يرجى المحاولة لاحقاً.");
        return { success: false, skipped: true, status: "Skipped_Source_Changed", runId: runId, branchId: targetBranchId, message: "تم تخطي حساب الرصيد لأن بيانات الحركة تغيّرت أثناء الحساب. يرجى المحاولة لاحقاً." };
      }
    }

    if (!committedVersionMatch || !snapshot) {
      throw new Error("Balance source version revalidation did not complete.");
    }

    if (targetBranchId) {
      requireActiveBranch_(ss, targetBranchId);
    }
    assertBalanceRuntimeBudget_(runtimeStartedAtMs, "Balance final write", runtimeBudgetMs);

    const warnings = [];
    if (snapshot.missingStartingCountWarnings > 0) {
      warnings.push("لا يوجد جرد سابق لبعض المواد، وتم احتساب الرصيد الابتدائي لها كصفر.");
    }
    if (snapshot.legacyReceivedFallbackWarnings > 0) {
      warnings.push("توجد تحويلات قديمة بدون received_normalized_quantity، فتم استخدام معادلة النقص القديمة لها فقط.");
    }
    const warningText = warnings.length ? " تنبيه: " + warnings.join(" ") : "";
    const noData = snapshot.rowsToAppend.length === 0;
    const runStatus = noData ? "No_Data" : "Success";
    const successMessage = noData
      ? "لم يتم إنشاء أي صفوف رصيد لهذه الفترة/الفرع. بقيت آخر لقطة رصيد محفوظة كما هي."
      : "تم تحديث الرصيد بنجاح لعدد " + snapshot.rowsToAppend.length + " سجل." + warningText;

    function appendCompletedRunLogs_() {
      const runLogRowsByBranch = {};
      const primaryRunLog = appendBalanceRunLog_(ss, {
        run_id: runId,
        trigger_type: triggerType,
        period_start: periodStart,
        period_end: periodEnd,
        period_month: targetPeriodMonth,
        branch_id: targetBranchId,
        status: runStatus,
        branches_processed: branchesProcessed,
        items_processed: itemsProcessed,
        started_at: startedAt,
        finished_at: new Date(),
        created_by: createdBy,
        message: successMessage
      });
      if (targetBranchId && primaryRunLog && primaryRunLog.rowNumber) {
        runLogRowsByBranch[targetBranchId] = primaryRunLog.rowNumber;
      }

      if (!targetBranchId && snapshot.branchIdsProcessed && snapshot.branchIdsProcessed.length) {
        snapshot.branchIdsProcessed.forEach(function(branchId) {
          const branchRunLog = appendBalanceRunLog_(ss, {
            run_id: runId,
            trigger_type: triggerType,
            period_start: periodStart,
            period_end: periodEnd,
            period_month: targetPeriodMonth,
            branch_id: branchId,
            status: runStatus,
            branches_processed: 1,
            items_processed: snapshot.branchItemCounts && snapshot.branchItemCounts[branchId] ? snapshot.branchItemCounts[branchId] : 0,
            started_at: startedAt,
            finished_at: new Date(),
            created_by: createdBy,
            message: successMessage
          });
          if (branchRunLog && branchRunLog.rowNumber) {
            runLogRowsByBranch[branchId] = branchRunLog.rowNumber;
          }
        });
      }
      return runLogRowsByBranch;
    }

    if (noData) {
      appendCompletedRunLogs_();
      return {
        success: true,
        status: runStatus,
        runId: runId,
        branchId: targetBranchId,
        calculatedAt: formatBalanceSnapshotDateTime_(snapshot.calculatedAt),
        branchesProcessed: branchesProcessed,
        itemsProcessed: itemsProcessed,
        rowsWritten: 0,
        message: successMessage
      };
    }

    if (snapshot.rowsToAppend.length > 0) {
      const balancesSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
      const historicalStartRow = Math.max(2, balancesSheet.getLastRow() + 1);
      balancesSheet.getRange(historicalStartRow, 1, snapshot.rowsToAppend.length, snapshot.rowWidth).setValues(snapshot.rowsToAppend);
      
      const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
      if (!currentSheet) {
        throw new Error("جدول Inventory_Balance_Current غير موجود.");
      }

      const currentHeaderMap = requireHeaderColumns_(currentSheet, getInventorySchemaRequirements_().Inventory_Balance_Current);
      const balancesHeaderMap = requireHeaderColumns_(balancesSheet, getInventorySchemaRequirements_().Inventory_Balances);
      
      const currentRowsToAppend = [];
      const nowTime = new Date();
      
      snapshot.rowsToAppend.forEach(function(hRow) {
        const rowObj = {
          branch_id: getCellByHeader_(hRow, balancesHeaderMap, "branch_id"),
          item_id: getCellByHeader_(hRow, balancesHeaderMap, "item_id"),
          period_month: getCellByHeader_(hRow, balancesHeaderMap, "period_month"),
          period_start: getCellByHeader_(hRow, balancesHeaderMap, "period_start"),
          period_end: getCellByHeader_(hRow, balancesHeaderMap, "period_end"),
          starting_balance: getCellByHeader_(hRow, balancesHeaderMap, "starting_balance"),
          total_in: getCellByHeader_(hRow, balancesHeaderMap, "total_in"),
          total_out: getCellByHeader_(hRow, balancesHeaderMap, "total_out"),
          balance: getCellByHeader_(hRow, balancesHeaderMap, "balance"),
          calculated_at: getCellByHeader_(hRow, balancesHeaderMap, "calculated_at"),
          calculated_by: getCellByHeader_(hRow, balancesHeaderMap, "calculated_by"),
          run_id: getCellByHeader_(hRow, balancesHeaderMap, "run_id"),
          updated_at: nowTime
        };
        const cRow = buildRowByHeaders_(currentHeaderMap, rowObj);
        currentRowsToAppend.push(cRow);
      });
      
      if (currentRowsToAppend.length > 0) {
        const currentStartRow = Math.max(2, currentSheet.getLastRow() + 1);
        currentSheet.getRange(currentStartRow, 1, currentRowsToAppend.length, currentHeaderMap.__lastColumn).setValues(currentRowsToAppend);

        // The success run-log remains the final trust-enabling business write.
        const runLogRowsByBranch = appendCompletedRunLogs_();
        try {
          const historicalSegments = buildContiguousBalanceBranchSegments_(snapshot.rowsToAppend, balancesHeaderMap, historicalStartRow);
          const currentSegments = buildContiguousBalanceBranchSegments_(currentRowsToAppend, currentHeaderMap, currentStartRow);
          const indexEntries = (snapshot.branchIdsProcessed || []).map(function(branchId) {
            const historicalSegment = historicalSegments[branchId];
            const currentSegment = currentSegments[branchId];
            const expectedItemCount = Number(snapshot.branchItemCounts && snapshot.branchItemCounts[branchId] || 0);
            if (
              !historicalSegment ||
              !currentSegment ||
              !runLogRowsByBranch[branchId] ||
              !expectedItemCount ||
              historicalSegment.rowCount !== expectedItemCount ||
              currentSegment.rowCount !== expectedItemCount
            ) {
              throw new Error("Committed balance rows cannot be represented by a trusted contiguous index entry.");
            }
            return {
              branchId: branchId,
              periodMonth: targetPeriodMonth,
              runId: runId,
              calculatedAt: snapshot.calculatedAt,
              currentStartRow: currentSegment.startRow,
              currentRowCount: currentSegment.rowCount,
              historicalStartRow: historicalSegment.startRow,
              historicalRowCount: historicalSegment.rowCount,
              runLogRow: runLogRowsByBranch[branchId],
              expectedItemCount: expectedItemCount,
              updatedAt: new Date()
            };
          });
          tryUpsertBalanceLatestIndexEntries_(ss, indexEntries);
        } catch (indexBuildError) {
          console.error("Optional balance latest index preparation failed", {
            message: indexBuildError && indexBuildError.message ? indexBuildError.message : String(indexBuildError)
          });
        }
      }
    }

    return {
      success: true,
      status: runStatus,
      runId: runId,
      branchId: targetBranchId,
      calculatedAt: formatBalanceSnapshotDateTime_(snapshot.calculatedAt),
      branchesProcessed: branchesProcessed,
      itemsProcessed: itemsProcessed,
      rowsWritten: snapshot.rowsToAppend.length,
      message: successMessage
    };
  } catch (e) {
    console.error("calculateBalanceSnapshotForPeriodInternal_ failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
    const safeMessage = e && e.balanceRuntimeBudgetExceeded ? BALANCE_RUNTIME_BUDGET_EXCEEDED_MESSAGE : "حدث خطأ غير متوقع.";
    try {
      if (!lockAcquired) {
        lock = LockService.getScriptLock();
        lockAcquired = lock.tryLock(5000);
      }
      if (lockAcquired) {
        appendBalanceRunLog_(ss, {
          run_id: runId,
          trigger_type: triggerType,
          period_start: periodStart,
          period_end: periodEnd,
          period_month: targetPeriodMonth,
          branch_id: targetBranchId,
          status: "Failed",
          branches_processed: branchesProcessed,
          items_processed: itemsProcessed,
          started_at: startedAt,
          finished_at: new Date(),
          created_by: createdBy,
          message: "فشل حساب الرصيد: " + safeMessage
        });
      }
    } catch (logError) {
      // Preserve the original calculation error; failed logging is reported in the response.
    }
    return { success: false, status: "Failed", runId: runId, branchId: targetBranchId, message: "فشل حساب الرصيد: " + safeMessage };
  } finally {
    if (lockAcquired && lock) lock.releaseLock();
  }
}

function calculateBalanceSnapshotForPeriod(periodMonth, optionalBranchId, sessionToken, triggerType) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();
    const targetBranchId = String(optionalBranchId || "").trim();
    if (targetBranchId) {
      requireActiveBranch_(ss, targetBranchId);
    }
    const requestedTriggerType = String(triggerType || "manual_owner").trim() || "manual_owner";
    return calculateBalanceSnapshotForPeriodInternal_({
      ss: ss,
      periodMonth: periodMonth,
      branchId: targetBranchId,
      triggerType: requestedTriggerType,
      createdBy: user.employeeNumber,
      lockWaitMs: 30000,
      startedAtMs: (new Date()).getTime(),
      runtimeBudgetMs: isOwnerManualBalanceTrigger_(requestedTriggerType) ? BALANCE_RUNTIME_BUDGET_MS : 0
    });
  } catch (e) {
    console.error("calculateBalanceSnapshotForPeriod failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
    const safeMessage = e && e.balanceRuntimeBudgetExceeded ? BALANCE_RUNTIME_BUDGET_EXCEEDED_MESSAGE : "حدث خطأ غير متوقع.";
    return { success: false, message: "فشل حساب الرصيد: " + safeMessage };
  }
}

function calculateInventoryBalances(periodMonth, optionalBranchId, sessionToken) {
  return calculateBalanceSnapshotForPeriod(periodMonth, optionalBranchId, sessionToken, "manual_owner");
}

function getBalanceRunValidationState_(runMap, runId, branchId, periodMonth) {
  const result = {
    valid: false,
    reason: "",
    category: "",
    runId: String(runId || "").trim(),
    branchId: String(branchId || "").trim(),
    periodMonth: String(periodMonth || "").trim()
  };

  if (!result.runId) {
    result.reason = "missing_run_id";
    result.category = "missing_run_id";
    return result;
  }
  if (!result.branchId) {
    result.reason = "missing_branch_id";
    result.category = "missing_branch_or_period";
    return result;
  }
  if (!result.periodMonth) {
    result.reason = "missing_period_month";
    result.category = "missing_branch_or_period";
    return result;
  }

  const exact = getSuccessfulBalanceRunForBranchPeriod_(runMap, result.runId, result.branchId, result.periodMonth);
  if (exact) {
    result.valid = true;
    result.reason = "success_exact_match";
    result.category = "valid";
    return result;
  }

  const runRows = runMap && runMap.runsByIdForDiagnostics ? (runMap.runsByIdForDiagnostics[result.runId] || []) : [];
  if (!runRows.length) {
    result.reason = "no_run_log_for_run_id";
    result.category = "no_successful_branch_period_run";
    return result;
  }

  let sameBranchDifferentPeriod = false;
  let samePeriodDifferentBranch = false;
  let exactNonSuccess = false;
  runRows.forEach(function(meta) {
    const metaBranch = String(meta.branchId || "").trim();
    const metaPeriod = String(meta.periodMonth || "").trim();
    const metaSuccess = isSuccessfulBalanceRunStatus_(meta.status);
    if (metaBranch === result.branchId && metaPeriod === result.periodMonth && !metaSuccess) exactNonSuccess = true;
    if (metaBranch === result.branchId && metaPeriod !== result.periodMonth && metaSuccess) sameBranchDifferentPeriod = true;
    if (metaBranch !== result.branchId && metaPeriod === result.periodMonth && metaSuccess) samePeriodDifferentBranch = true;
  });

  if (exactNonSuccess) {
    result.reason = "matching_run_log_not_success";
    result.category = "no_successful_branch_period_run";
  } else if (sameBranchDifferentPeriod || samePeriodDifferentBranch) {
    result.reason = "run_log_branch_or_period_mismatch";
    result.category = "branch_period_mismatch";
  } else {
    result.reason = "no_successful_branch_period_run";
    result.category = "no_successful_branch_period_run";
  }
  return result;
}

function collectBalanceStorageDiagnostics_(ss) {
  const runMap = getSuccessfulBalanceRunMap_(ss);
  const diagnostics = {
    currentRowsMissingRunId: [],
    currentRowsInvalidRunLog: [],
    currentRowsRunLogBranchPeriodMismatch: [],
    historicalRowsInvalidRunLog: [],
    duplicateCurrentRows: [],
    scheduledSharedRunValidationMismatchRisk: []
  };
  const sampleLimit = 50;

  function pushLimited_(collection, item) {
    if (collection.length < sampleLimit) collection.push(item);
  }

  function inspectSnapshotSheet_(sheetName, targetCollectionName, includeDuplicates) {
    const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
    if (!sheet || sheet.getLastRow() < 2) return;
    const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_()[sheetName]);
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, headerMap.__lastColumn).getValues();
    const keyCounts = {};

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNumber = i + 2;
      const runId = String(getCellByHeader_(row, headerMap, "run_id") || "").trim();
      const branchId = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
      const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
      const periodMonth = String(getCellByHeader_(row, headerMap, "period_month") || "").trim();

      if (includeDuplicates && branchId && itemId && periodMonth && runId) {
        const key = branchId + "|" + itemId + "|" + periodMonth + "|" + runId;
        if (!keyCounts[key]) keyCounts[key] = { count: 0, firstRow: rowNumber };
        keyCounts[key].count++;
      }

      const state = getBalanceRunValidationState_(runMap, runId, branchId, periodMonth);
      if (state.valid) continue;
      const detail = {
        rowNumber: rowNumber,
        runId: runId,
        branchId: branchId,
        itemId: itemId,
        periodMonth: periodMonth,
        reason: state.reason
      };
      if (sheetName === "Inventory_Balance_Current" && state.category === "missing_run_id") {
        pushLimited_(diagnostics.currentRowsMissingRunId, detail);
      }
      if (sheetName === "Inventory_Balance_Current" && state.category === "branch_period_mismatch") {
        pushLimited_(diagnostics.currentRowsRunLogBranchPeriodMismatch, detail);
      }
      pushLimited_(diagnostics[targetCollectionName], detail);
    }

    if (includeDuplicates) {
      Object.keys(keyCounts).forEach(function(key) {
        if (keyCounts[key].count > 1) {
          pushLimited_(diagnostics.duplicateCurrentRows, {
            key: key,
            count: keyCounts[key].count,
            firstRow: keyCounts[key].firstRow
          });
        }
      });
    }
  }

  inspectSnapshotSheet_("Inventory_Balance_Current", "currentRowsInvalidRunLog", true);
  inspectSnapshotSheet_("Inventory_Balances", "historicalRowsInvalidRunLog", false);

  const runIds = Object.keys(runMap.runsByIdForDiagnostics || {});
  runIds.forEach(function(runId) {
    const rows = runMap.runsByIdForDiagnostics[runId] || [];
    const scheduledRows = rows.filter(function(meta) {
      return String(meta.triggerType || "").trim().toUpperCase() === "SCHEDULED";
    });
    if (scheduledRows.length < 2) return;
    let successBranches = 0;
    let nonSuccessBranches = 0;
    const branches = {};
    scheduledRows.forEach(function(meta) {
      const branchId = String(meta.branchId || "").trim();
      if (branchId) branches[branchId] = true;
      if (branchId && isSuccessfulBalanceRunStatus_(meta.status)) successBranches++;
      else if (branchId) nonSuccessBranches++;
    });
    if (successBranches > 0 && nonSuccessBranches > 0) {
      pushLimited_(diagnostics.scheduledSharedRunValidationMismatchRisk, {
        runId: runId,
        branchCount: Object.keys(branches).length,
        successBranchRows: successBranches,
        nonSuccessBranchRows: nonSuccessBranches,
        validation: "exact_run_id_branch_id_period_month_required"
      });
    }
  });

  return diagnostics;
}

function adminBalanceStorageHealthCheck(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Verify owner authorization
    requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();
    
    const historicalSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
    const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
    
    const historicalRowCount = historicalSheet && historicalSheet.getLastRow() > 1 ? historicalSheet.getLastRow() - 1 : 0;
    const currentRowCount = currentSheet && currentSheet.getLastRow() > 1 ? currentSheet.getLastRow() - 1 : 0;
    
    const diagnostics = collectBalanceStorageDiagnostics_(ss);
    const duplicates = diagnostics.duplicateCurrentRows.map(function(item) {
      return item.key + " (count: " + item.count + ")";
    });
    const warningLimit = 5000;
    let warning = "";
    
    if (historicalRowCount > warningLimit) {
      warning = "Warning: Historical snapshot rows exceed " + warningLimit + ". Current count is " + historicalRowCount + ". Consider performing storage maintenance.";
    }
    
    return {
      success: true,
      historicalRowCount: historicalRowCount,
      currentRowCount: currentRowCount,
      duplicates: duplicates,
      diagnostics: diagnostics,
      warning: warning
    };
  } catch (e) {
    console.error("adminBalanceStorageHealthCheck failed", e);
    return { success: false, message: "فشل فحص تخزين الرصيد حالياً." };
  }
}

function adminInventoryEnhancementHealthCheck(sessionToken) {
  const checks = [];
  let passedCount = 0;
  let warningCount = 0;
  let criticalCount = 0;
  const checkedAt = typeof formatBalanceSnapshotDateTime_ === "function" ? formatBalanceSnapshotDateTime_(new Date()) : new Date().toISOString();

  function addCheck_(key, status, message, details) {
    checks.push({
      key: key,
      status: status,
      message: message,
      details: details || {}
    });
    if (status === "pass") passedCount++;
    else if (status === "warning") warningCount++;
    else if (status === "critical") criticalCount++;
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // Verify owner authorization
    requireOwnerForAdmin_(sessionToken);

    // 1. Auth/security
    let authPass = true;
    const adminFuncs = {
      calculateInventoryBalances: typeof calculateInventoryBalances === "function" ? calculateInventoryBalances : null,
      adminBalanceStorageHealthCheck: typeof adminBalanceStorageHealthCheck === "function" ? adminBalanceStorageHealthCheck : null,
      adminInventoryEnhancementHealthCheck: typeof adminInventoryEnhancementHealthCheck === "function" ? adminInventoryEnhancementHealthCheck : null,
      getOwnerDashboardData: typeof getOwnerDashboardData === "function" ? getOwnerDashboardData : null,
      getOwnerPurchases: typeof getOwnerPurchases === "function" ? getOwnerPurchases : null,
      getOwnerTransfers: typeof getOwnerTransfers === "function" ? getOwnerTransfers : null,
      ownerRecalculateBranchBalance: typeof ownerRecalculateBranchBalance === "function" ? ownerRecalculateBranchBalance : null
    };

    const missingOwnerAuth = [];
    Object.keys(adminFuncs).forEach(function(fnName) {
      const fnObj = adminFuncs[fnName];
      if (fnObj) {
        const source = fnObj.toString();
        if (source.indexOf("requireOwner_") === -1 && source.indexOf("requireOwnerForAdmin_") === -1) {
          missingOwnerAuth.push(fnName);
          authPass = false;
        }
      } else {
        missingOwnerAuth.push(fnName + " (not_defined)");
        authPass = false;
      }
    });

    if (authPass) {
      addCheck_("auth_security_admin_functions", "pass", "جميع وظائف الإدارة محمية بنجاح وتتطلب صلاحية المالك.", { verified: Object.keys(adminFuncs) });
    } else {
      addCheck_("auth_security_admin_functions", "critical", "بعض وظائف الإدارة غير محمية بصلاحية المالك.", { missing: missingOwnerAuth });
    }

    addCheck_("requireOwner_ exists", typeof requireOwner_ === "function" ? "pass" : "critical", typeof requireOwner_ === "function" ? "دالة التحقق requireOwner_ متوفرة." : "دالة التحقق requireOwner_ غير متوفرة.");
    addCheck_("requireOwnerForAdmin_ exists", typeof requireOwnerForAdmin_ === "function" ? "pass" : "critical", typeof requireOwnerForAdmin_ === "function" ? "دالة التحقق requireOwnerForAdmin_ متوفرة." : "دالة التحقق requireOwnerForAdmin_ غير متوفرة.");

    // 2. PIN Hashing Schema & Columns & Helpers
    const usersSchemaReqs = getInventorySchemaRequirements_().Users || [];
    const schemaHasHash = usersSchemaReqs.indexOf("pin_hash") !== -1;
    const schemaHasSalt = usersSchemaReqs.indexOf("pin_salt") !== -1;
    const schemaHasMigrated = usersSchemaReqs.indexOf("pin_migrated_at") !== -1;

    if (schemaHasHash && schemaHasSalt && schemaHasMigrated) {
      addCheck_("pin_hashing_schema", "pass", "بنية جدول المستخدمين تدعم أعمدة التشفير الجديدة.", { schema: usersSchemaReqs });
    } else {
      addCheck_("pin_hashing_schema", "critical", "بنية جدول المستخدمين لا تدعم أعمدة التشفير الجديدة بشكل كامل.", { schema: usersSchemaReqs });
    }

    const usersSheet = getSheetByNameCaseInsensitive_(ss, "Users");
    const usersHeaderMap = usersSheet ? getHeaderMap_(usersSheet) : {};
    const hasPinHash = !!getHeaderIndex_(usersHeaderMap, "pin_hash");
    const hasPinSalt = !!getHeaderIndex_(usersHeaderMap, "pin_salt");
    const hasPinMigrated = !!getHeaderIndex_(usersHeaderMap, "pin_migrated_at");

    if (hasPinHash && hasPinSalt && hasPinMigrated) {
      addCheck_("pin_hash_columns_exist", "pass", "أعمدة تشفير الرمز السري موجودة في جدول المستخدمين.", { hasPinHash: true, hasPinSalt: true, hasPinMigrated: true });
    } else {
      addCheck_("pin_hash_columns_exist", "warning", "أعمدة تشفير الرمز السري غير متوفرة في جدول المستخدمين الحالي.", { hasPinHash: hasPinHash, hasPinSalt: hasPinSalt, hasPinMigrated: hasPinMigrated });
    }

    const hashHelpersExist = typeof hashPin_ === "function" && typeof generatePinSalt_ === "function" && typeof verifyPinForUser_ === "function" && typeof migrateLegacyPinToHashIfNeeded_ === "function";
    if (hashHelpersExist) {
      addCheck_("login_hardening_hash_helpers", "pass", "دوال التشفير والترحيل المساعدة متوفرة بالنظام.");
    } else {
      addCheck_("login_hardening_hash_helpers", "critical", "بعض دوال التشفير والترحيل المساعدة غير متوفرة.");
    }

    const verifyLoginSource = typeof verifyLogin === "function" ? verifyLogin.toString() : "";
    const usesVerifyPinForUser = verifyLoginSource.indexOf("verifyPinForUser_") !== -1;
    if (usesVerifyPinForUser) {
      addCheck_("login_hardening_uses_verify_helper", "pass", "دالة verifyLogin تستخدم دالة التحقق verifyPinForUser_.");
    } else {
      addCheck_("login_hardening_uses_verify_helper", "critical", "دالة verifyLogin لا تستخدم دالة التحقق verifyPinForUser_.");
    }

    const hasPinExposure = 
      /["']?pin["']?\s*:/i.test(verifyLoginSource) || 
      /["']?pin_hash["']?\s*:/i.test(verifyLoginSource) || 
      /["']?pin_salt["']?\s*:/i.test(verifyLoginSource) || 
      /["']?pinHash["']?\s*:/i.test(verifyLoginSource) || 
      /["']?pinSalt["']?\s*:/i.test(verifyLoginSource);
    const returnsNoPin = !hasPinExposure;
    if (returnsNoPin) {
      addCheck_("login_hardening_no_pin_exposure", "pass", "دالة verifyLogin لا تقوم بإرجاع كلمة المرور أو بيانات التشفير الحساسة.");
    } else {
      addCheck_("login_hardening_no_pin_exposure", "critical", "دالة verifyLogin تقوم بتسريب كلمة المرور أو بيانات تشفير حساسة.");
    }

    // 3. Login Locking
    const hasGlobalLock = verifyLoginSource.indexOf("LockService.getScriptLock()") !== -1;
    if (!hasGlobalLock) {
      addCheck_("login_lock_scope_narrow", "pass", "دالة تسجيل الدخول لا تستخدم قفل نصي شامل.");
    } else {
      addCheck_("login_lock_scope_narrow", "critical", "دالة تسجيل الدخول لا تزال تستخدم قفل نصي شامل لكامل الدالة.");
    }
    addCheck_("login_lock_helper_exists", typeof withShortScriptLock_ === "function" ? "pass" : "critical", "دالة القفل القصير withShortScriptLock_ متوفرة.");

    // 4. Manager Balance Rule
    const managerFeatureVisibilitySource = typeof getManagerFeatureVisibility === "function" ? getManagerFeatureVisibility.toString() : "";
    const isNotControlled = managerFeatureVisibilitySource.indexOf("inventory_balance: true") !== -1;
    if (isNotControlled) {
      addCheck_("manager_balance_visibility", "pass", "رؤية الرصيد للمدراء متاحة دائماً ولا يتم التحكم بها من إعدادات الفروع.");
    } else {
      addCheck_("manager_balance_visibility", "critical", "رؤية الرصيد للمدراء يتم التحكم بها من إعدادات الفروع بشكل خاطئ.");
    }

    const getInventoryBalancesSource = typeof getInventoryBalances === "function" ? getInventoryBalances.toString() : "";
    const noCalc = getInventoryBalancesSource.indexOf("calculateInventoryBalances") === -1 &&
                   getInventoryBalancesSource.indexOf("calculateBalanceSnapshotForPeriod") === -1 &&
                   getInventoryBalancesSource.indexOf("ownerRecalculateBranchBalance") === -1;
    if (noCalc) {
      addCheck_("manager_balance_read_no_calc", "pass", "قراءة الرصيد للمدراء لا تقوم بتشغيل عمليات الحساب وتعتمد على اللقطات المحفوظة فقط.");
    } else {
      addCheck_("manager_balance_read_no_calc", "critical", "دالة قراءة الرصيد للمدراء تستدعي دالة الحساب بشكل مباشر.");
    }

    const usesSaved = getInventoryBalancesSource.indexOf("Inventory_Balance_Current") !== -1 || getInventoryBalancesSource.indexOf("Inventory_Balances") !== -1;
    if (usesSaved) {
      addCheck_("manager_balance_read_source", "pass", "دالة قراءة الرصيد تقرأ من جداول اللقطات المحفوظة أو الجدول الحالي.");
    } else {
      addCheck_("manager_balance_read_source", "critical", "دالة قراءة الرصيد لا تقرأ من جداول اللقطات المحفوظة بشكل صحيح.");
    }

    // 5. Owner Settings Rule
    const setFeatureVisibilitySource = typeof setFeatureVisibility === "function" ? setFeatureVisibility.toString() : "";
    const onlyCount = setFeatureVisibilitySource.indexOf("inventory_balance") !== -1 && setFeatureVisibilitySource.indexOf("رصيد لا يتم التحكم به") !== -1;
    if (onlyCount) {
      addCheck_("owner_settings_control_jard_only", "pass", "إعدادات الفروع للمالك تتحكم بصلاحية الجرد فقط وتمنع تعديل صلاحية الرصيد.");
    } else {
      addCheck_("owner_settings_control_jard_only", "critical", "إعدادات الفروع للمالك تسمح بتعديل صلاحية الرصيد.");
    }

    // 6. Balance Storage
    const historicalSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balances");
    const currentSheet = getSheetByNameCaseInsensitive_(ss, "Inventory_Balance_Current");
    const historicalExists = !!historicalSheet;
    const currentExists = !!currentSheet;
    const historicalRowCount = historicalExists && historicalSheet.getLastRow() > 1 ? historicalSheet.getLastRow() - 1 : 0;
    const currentRowCount = currentExists && currentSheet.getLastRow() > 1 ? currentSheet.getLastRow() - 1 : 0;

    if (historicalExists && currentExists) {
      addCheck_("balance_storage_sheets_exist", "pass", "جداول الرصيد التاريخي والرصيد الحالي موجودة بالنظام.", { historicalRowCount: historicalRowCount, currentRowCount: currentRowCount });
    } else {
      addCheck_("balance_storage_sheets_exist", "critical", "جداول الرصيد مفقودة من النظام.");
    }

    const balanceDiagnostics = collectBalanceStorageDiagnostics_(ss);
    const duplicateCount = balanceDiagnostics.duplicateCurrentRows.length;
    const duplicateKeys = balanceDiagnostics.duplicateCurrentRows.map(function(item) {
      return item.key + " (تكرار: " + item.count + ")";
    });

    if (duplicateCount === 0) {
      addCheck_("current_balance_no_duplicates", "pass", "لا توجد أي مفاتيح مكررة في جدول الرصيد الحالي.");
    } else {
      addCheck_("current_balance_no_duplicates", "critical", "تم العثور على مفاتيح مكررة في جدول الرصيد الحالي.", { duplicates: duplicateKeys });
    }

    addCheck_(
      "current_balance_rows_have_run_id",
      balanceDiagnostics.currentRowsMissingRunId.length === 0 ? "pass" : "critical",
      balanceDiagnostics.currentRowsMissingRunId.length === 0 ? "كل صفوف الرصيد الحالي تحمل رقم تشغيل." : "توجد صفوف رصيد حالي بدون run_id.",
      { rows: balanceDiagnostics.currentRowsMissingRunId }
    );
    addCheck_(
      "current_balance_rows_have_successful_branch_period_run",
      balanceDiagnostics.currentRowsInvalidRunLog.length === 0 ? "pass" : "critical",
      balanceDiagnostics.currentRowsInvalidRunLog.length === 0 ? "كل صفوف الرصيد الحالي مرتبطة بتشغيل ناجح لنفس الفرع والشهر." : "توجد صفوف رصيد حالي بدون تشغيل ناجح مطابق للفرع والشهر.",
      { rows: balanceDiagnostics.currentRowsInvalidRunLog }
    );
    addCheck_(
      "current_balance_run_log_branch_period_match",
      balanceDiagnostics.currentRowsRunLogBranchPeriodMismatch.length === 0 ? "pass" : "critical",
      balanceDiagnostics.currentRowsRunLogBranchPeriodMismatch.length === 0 ? "لا توجد صفوف رصيد حالي برقم تشغيل يطابق فرعاً أو شهراً آخر فقط." : "توجد صفوف رصيد حالي برقم تشغيل لا يطابق نفس الفرع والشهر.",
      { rows: balanceDiagnostics.currentRowsRunLogBranchPeriodMismatch }
    );
    addCheck_(
      "historical_balance_rows_have_successful_branch_period_run",
      balanceDiagnostics.historicalRowsInvalidRunLog.length === 0 ? "pass" : "critical",
      balanceDiagnostics.historicalRowsInvalidRunLog.length === 0 ? "كل صفوف الرصيد التاريخي مرتبطة بتشغيل ناجح لنفس الفرع والشهر." : "توجد صفوف رصيد تاريخي بدون تشغيل ناجح مطابق للفرع والشهر.",
      { rows: balanceDiagnostics.historicalRowsInvalidRunLog }
    );
    addCheck_(
      "scheduled_shared_run_validation_branch_period_safe",
      typeof getSuccessfulBalanceRunForBranchPeriod_ === "function" && typeof getBalanceRunBranchPeriodKey_ === "function" ? "pass" : "critical",
      "قراءة الرصيد المجدول تتحقق من run_id + branch_id + period_month، ولا تعتمد على run_id وحده.",
      { mixedScheduledSharedRuns: balanceDiagnostics.scheduledSharedRunValidationMismatchRisk }
    );

    // 7. Schema checks from the second definition
    addCheck_("ensureInventoryEnhancementSchema_ exists", typeof ensureInventoryEnhancementSchema_ === "function" ? "pass" : "critical");

    const tSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
    if (tSheet) {
      const tMap = getHeaderMap_(tSheet);
      addCheck_("source_branch header exists in Transfers", getHeaderIndexWithAliases_(tMap, "Transfers", "source_branch") > 0 ? "pass" : "critical");
    } else {
      addCheck_("source_branch header exists in Transfers", "critical", "Transfers sheet missing");
    }

    const checkSheetHeaders = function(sheetName) {
      const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (sheet) {
        try {
          requireHeaderColumns_(sheet, getInventorySchemaRequirements_()[sheetName]);
          addCheck_(sheetName + " exists with required headers", "pass");
        } catch(e) {
          console.error("adminInventoryEnhancementHealthCheck header check failed", { sheetName: sheetName, error: e });
          addCheck_(sheetName + " exists with required headers", "critical", "تعذر فحص أعمدة الجدول حالياً.");
        }
      } else {
        addCheck_(sheetName + " exists with required headers", "critical", "Missing sheet");
      }
    };

    checkSheetHeaders("Feature_Visibility");
    checkSheetHeaders("Inventory_Control");
    checkSheetHeaders("Inventory_Counts");
    checkSheetHeaders("Inventory_Count_Lines");
    checkSheetHeaders("Inventory_Balances");
    checkSheetHeaders("Inventory_Balance_Run_Log");

    addCheck_("owner endpoints exist", (typeof getOwnerDashboardData === "function" && typeof getOwnerTransfers === "function" && typeof setFeatureVisibility === "function" && typeof calculateBalanceSnapshotForPeriod === "function") ? "pass" : "critical");
    addCheck_("manager inventory endpoints exist", (typeof submitInventoryCount === "function" && typeof getInventoryBalances === "function") ? "pass" : "critical");
    addCheck_("mutation token functions exist", (typeof createMutationToken_ === "function" && typeof consumeMutationToken_ === "function") ? "pass" : "critical");

    // Cost parser behavior
    try {
      let threwOnEmptyReq = false;
      try { parseCostInput_("", true); } catch(e) { threwOnEmptyReq = true; }
      let zeroVal = parseCostInput_("0", true);
      let emptyFalseVal = parseCostInput_("", false);
      let threwOnNegative = false;
      try { parseCostInput_("-1", false); } catch(e) { threwOnNegative = true; }

      addCheck_("cost parser behavior", (threwOnEmptyReq && zeroVal === 0 && emptyFalseVal === 0 && threwOnNegative) ? "pass" : "critical");
    } catch(e) {
      console.error("adminInventoryEnhancementHealthCheck cost parser check failed", e);
      addCheck_("cost parser behavior", "critical", "تعذر تنفيذ فحص التكلفة حالياً.");
    }

    // periodMonth regex
    const regex = /^\d{4}-\d{2}$/;
    addCheck_("periodMonth regex validates YYYY-MM", (regex.test("2023-10") && !regex.test("2023-1") && !regex.test("23-10")) ? "pass" : "critical");

  } catch (e) {
    console.error("adminInventoryEnhancementHealthCheck failed", e);
    addCheck_("Fatal Error in Health Check", "critical", "تعذر تنفيذ فحص صحة النظام حالياً.");
  }

  const success = criticalCount === 0;
  return {
    success: success,
    checkedAt: checkedAt,
    summary: {
      critical: criticalCount,
      warnings: warningCount,
      passed: passedCount
    },
    checks: checks
  };
}

function scheduledInventoryBalanceCalculation_() {
  // One scheduled parent run_id may group branch attempts, but reads only trust branch-specific successful run-log rows.
  const runId = createBalanceRunId_();
  const startedAt = new Date();
  const periodMonth = getCurrentInventoryPeriod_();
  let ss = null;
  const branchResults = [];
  let branchesProcessed = 0;
  let itemsProcessed = 0;
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;

  try {
    ensureRuntimeSchemaReady_();
    ss = SpreadsheetApp.getActiveSpreadsheet();
    const activeBranchIds = getActiveBalanceBranchIds_(ss);

    for (let i = 0; i < activeBranchIds.length; i++) {
      const branchId = activeBranchIds[i];
      const result = calculateBalanceSnapshotForPeriodInternal_({
        ss: ss,
        periodMonth: periodMonth,
        branchId: branchId,
        triggerType: "SCHEDULED",
        createdBy: "SYSTEM",
        runId: runId,
        startedAt: startedAt,
        lockWaitMs: 5000
      });
      branchResults.push(result);
      if (result && result.success) {
        successCount++;
        branchesProcessed += result.branchesProcessed || 1;
        itemsProcessed += result.itemsProcessed || 0;
      } else if (result && result.status === "Skipped_Lock_Busy") {
        skippedCount++;
      } else {
        failureCount++;
      }
    }

    const status = failureCount > 0 || skippedCount > 0
      ? (successCount > 0 ? "Partial_Success" : (skippedCount > 0 ? "Skipped_Lock_Busy" : "Failed"))
      : "Success";
    appendBalanceRunLogWithLock_(ss, {
      run_id: runId,
      trigger_type: "SCHEDULED",
      period_start: getBalancePeriodBounds_(periodMonth).periodStart,
      period_end: getBalancePeriodBounds_(periodMonth).periodEnd,
      period_month: periodMonth,
      branch_id: "",
      status: status,
      branches_processed: branchesProcessed,
      items_processed: itemsProcessed,
      started_at: startedAt,
      finished_at: new Date(),
      created_by: "SYSTEM",
      message: "تشغيل مجدول: نجاح " + successCount + "، فشل " + failureCount + "، تخطي القفل " + skippedCount + "."
    }, 5000);

    return {
      success: status === "Success" || status === "Partial_Success",
      status: status,
      runId: runId,
      periodMonth: periodMonth,
      branchesProcessed: branchesProcessed,
      itemsProcessed: itemsProcessed,
      branchResults: branchResults,
      message: "تم تنفيذ حساب الرصيد المجدول."
    };
  } catch (e) {
    console.error("scheduledInventoryBalanceCalculation_ failed", e);
    const safeMessage = "حدث خطأ غير متوقع.";
    try {
      if (ss) {
        appendBalanceRunLogWithLock_(ss, {
          run_id: runId,
          trigger_type: "SCHEDULED",
          period_month: periodMonth,
          status: "Failed",
          branches_processed: branchesProcessed,
          items_processed: itemsProcessed,
          started_at: startedAt,
          finished_at: new Date(),
          created_by: "SYSTEM",
          message: "فشل تشغيل الرصيد المجدول: " + safeMessage
        }, 5000);
      }
    } catch (logError) {
      // The scheduled entrypoint must not throw if diagnostics cannot be written.
    }
    return { success: false, status: "Failed", runId: runId, message: "فشل تشغيل الرصيد المجدول: " + safeMessage, branchResults: branchResults };
  }
}

function installInventoryBalanceTriggers(sessionToken) {
  try {
    requireOwnerForAdmin_(sessionToken);
    const handlerName = "scheduledInventoryBalanceCalculation_";
    const managedHandlerNames = {
      scheduledInventoryBalanceCalculation: true,
      scheduledInventoryBalanceCalculation_: true
    };
    const triggers = ScriptApp.getProjectTriggers();
    let deleted = 0;
    for (let i = 0; i < triggers.length; i++) {
      const triggerHandlerName = triggers[i].getHandlerFunction ? triggers[i].getHandlerFunction() : "";
      if (managedHandlerNames[triggerHandlerName]) {
        ScriptApp.deleteTrigger(triggers[i]);
        deleted++;
      }
    }

    const hour = 4;
    ScriptApp.newTrigger(handlerName)
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(hour)
      .create();
    ScriptApp.newTrigger(handlerName)
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.FRIDAY)
      .atHour(hour)
      .create();

    return {
      success: true,
      deletedExistingTriggers: deleted,
      installedTriggers: 2,
      days: ["MONDAY", "FRIDAY"],
      hour: hour,
      timezone: Session.getScriptTimeZone(),
      message: "تم تثبيت مشغلات حساب الرصيد ليومي الاثنين والجمعة."
    };
  } catch (e) {
    console.error("installInventoryBalanceTriggers failed", e);
    return { success: false, message: "تعذر تثبيت مشغلات حساب الرصيد حالياً." };
  }
}

function ownerRecalculateBranchBalance(sessionToken, branchId) {
  let guardKey = "";
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = requireOwner_(ss, sessionToken);
    ensureRuntimeSchemaReady_();
    const targetBranchId = String(branchId || "").trim();
    requireActiveBranch_(ss, targetBranchId);
    const periodMonth = getCurrentInventoryPeriod_();
    const guard = tryAcquireBalanceRecalcGuard_(targetBranchId, periodMonth, user.employeeNumber);
    if (!guard.acquired) {
      return { success: false, message: BALANCE_RECALC_GUARD_BUSY_MESSAGE };
    }
    guardKey = guard.key || "";

    const result = calculateBalanceSnapshotForPeriod(periodMonth, targetBranchId, sessionToken, "OWNER_MANUAL");
    if (!result || !result.success) {
      return { success: false, message: result && result.message ? result.message : "تعذر إعادة حساب الرصيد." };
    }

    const branch = getReferenceBranches_(ss).byId[targetBranchId] || { id: targetBranchId, name: targetBranchId };
    const branchSettings = getOwnerBranchSettings_(ss, [{ id: targetBranchId, name: branch.name || branch.nameAr || targetBranchId }]);
    return {
      success: true,
      branchId: targetBranchId,
      calculatedAt: result.calculatedAt || "",
      message: result.message || "تمت إعادة حساب الرصيد بنجاح.",
      runId: result.runId || "",
      branchSetting: branchSettings.length ? branchSettings[0] : null
    };
  } catch (e) {
    console.error("ownerRecalculateBranchBalance failed", {
      message: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack : ""
    });
    return { success: false, message: "تعذر إعادة حساب الرصيد حالياً. يرجى المحاولة لاحقاً." };
  } finally {
    clearBalanceRecalcGuard_(guardKey);
  }
}


// Removed duplicate adminInventoryEnhancementHealthCheck definition


// ==================================================
// PHASE 4 — OWNER BACKEND ENDPOINTS
// ==================================================

const OWNER_SETTINGS_PATCH_VERSION_ = "owner-settings-fallback-v2-2026-07-09";

function buildOwnerSettingsFailureResponse_(diagnosticCode, checkpoints, message) {
  return {
    success: false,
    message: message || "تعذر تحميل إعدادات الفروع حالياً.",
    patchVersion: OWNER_SETTINGS_PATCH_VERSION_,
    diagnosticCode: diagnosticCode || "OWNER_SETTINGS_FAILED",
    checkpoints: Array.isArray(checkpoints) ? checkpoints : []
  };
}

function debugOwnerSettingsData(sessionToken) {
  return getOwnerSettingsData(sessionToken);
}

function ownerBackfillMovementSummaries(sessionToken, options) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  const startedAtMs = new Date().getTime();
  const result = {
    success: false,
    processedPurchases: 0,
    processedTransfers: 0,
    summaryRowsWritten: 0,
    pendingIndexRowsWritten: 0,
    remaining: 0,
    message: ""
  };
  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    ensureRuntimeSchemaReady_();
    const ss = adminContext.ss;
    const user = adminContext.owner || {};
    const opts = options || {};
    const source = String(opts.source || "both").trim().toLowerCase();
    if (["purchases", "transfers", "both"].indexOf(source) === -1) {
      return { success: false, message: "مصدر التحديث غير صحيح.", processedPurchases: 0, processedTransfers: 0, summaryRowsWritten: 0, pendingIndexRowsWritten: 0, remaining: 0 };
    }
    const dateRange = resolveOwnerReportDateRange_({ dateFrom: opts.dateFrom, dateTo: opts.dateTo });
    const targetBranch = String(opts.branchId || "").trim();
    if (targetBranch) requireActiveBranch_(ss, targetBranch);
    const maxRows = Math.max(1, parseInt(opts.maxRows, 10) || MOVEMENT_BACKFILL_DEFAULT_MAX_ROWS);
    const now = new Date();

    lock.waitLock(15000);
    lockAcquired = true;
    assertSubmissionBalancesReady_(ss);

    const summaryEntries = [];
    const pendingIndexEntries = [];
    let scannedRows = 0;
    let totalRows = 0;

    if (source === "purchases" || source === "both") {
      const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
      if (purchasesSheet && purchasesSheet.getLastRow() > 1) {
        const headerMap = requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases);
        const recentRows = getRecentSheetRows_(purchasesSheet, headerMap, maxRows);
        const data = recentRows.values;
        scannedRows += data.length;
        totalRows += Math.max(0, purchasesSheet.getLastRow() - 1);
        for (let i = 0; i < data.length; i++) {
          if (i % 100 === 0 && new Date().getTime() - startedAtMs > MOVEMENT_BACKFILL_RUNTIME_BUDGET_MS) {
            throw new Error("انتهى وقت تحديث ملخصات الحركة قبل اكتمال الدفعة. يمكن إعادة تشغيل العملية لاستكمال الباقي.");
          }
          const row = data[i];
          const bId = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
          if (targetBranch && bId !== targetBranch) continue;
          const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
          if (!createdAt || createdAt < dateRange.dateFromStart || createdAt >= dateRange.dateToExclusive) continue;
          const entry = buildPurchaseSummaryEntryFromRow_(row, headerMap, recentRows.startRow + i, now);
          if (entry) {
            summaryEntries.push(entry);
            result.processedPurchases++;
          }
        }
      }
    }

    if (source === "transfers" || source === "both") {
      const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
      if (transfersSheet && transfersSheet.getLastRow() > 1) {
        const headerMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);
        const recentRows = getRecentSheetRows_(transfersSheet, headerMap, maxRows);
        const data = recentRows.values;
        scannedRows += data.length;
        totalRows += Math.max(0, transfersSheet.getLastRow() - 1);
        for (let i = 0; i < data.length; i++) {
          if (i % 100 === 0 && new Date().getTime() - startedAtMs > MOVEMENT_BACKFILL_RUNTIME_BUDGET_MS) {
            throw new Error("انتهى وقت تحديث ملخصات الحركة قبل اكتمال الدفعة. يمكن إعادة تشغيل العملية لاستكمال الباقي.");
          }
          const row = data[i];
          const target = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
          const sourceBranch = String(getCellByHeader_(row, headerMap, "source_branch") || "DISTRIBUTOR").trim() || "DISTRIBUTOR";
          if (targetBranch && target !== targetBranch && sourceBranch !== targetBranch) continue;
          const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
          if (!createdAt || createdAt < dateRange.dateFromStart || createdAt >= dateRange.dateToExclusive) continue;
          const sourceRow = recentRows.startRow + i;
          summaryEntries.push.apply(summaryEntries, buildTransferSummaryEntriesFromRow_(row, headerMap, sourceRow, now, "created"));
          summaryEntries.push.apply(summaryEntries, buildTransferSummaryEntriesFromRow_(row, headerMap, sourceRow, now, "received"));
          pendingIndexEntries.push(buildPendingTransferIndexEntryFromRow_(row, headerMap, sourceRow, now));
          result.processedTransfers++;
        }
      }
    }

    const summaryWrite = upsertMovementDailySummaries_(ss, summaryEntries, { updatedAt: now });
    const indexWrite = upsertPendingTransferIndexRows_(ss, pendingIndexEntries);
    result.summaryRowsWritten = summaryWrite.rowsWritten || 0;
    result.pendingIndexRowsWritten = indexWrite.rowsWritten || 0;
    result.remaining = Math.max(0, totalRows - scannedRows);
    result.success = true;
    result.message = result.remaining > 0
      ? "تم تحديث دفعة من ملخصات الحركة. توجد صفوف أقدم يمكن استكمالها بتشغيل التحديث مرة أخرى أو زيادة الحد."
      : "تم تحديث ملخصات الحركة والفهرس بنجاح.";
    logActionDetail_("OWNER_BACKFILL_MOVEMENT_SUMMARIES", "Owner backfilled movement summaries", {
      entityType: "movement_summary",
      source: source,
      branchId: targetBranch,
      processedPurchases: result.processedPurchases,
      processedTransfers: result.processedTransfers,
      summaryRowsWritten: result.summaryRowsWritten,
      pendingIndexRowsWritten: result.pendingIndexRowsWritten,
      remaining: result.remaining
    }, getSheetByNameCaseInsensitive_(ss, "Logs"), now);
    return result;
  } catch (e) {
    console.error("ownerBackfillMovementSummaries failed", e);
    result.message = e && e.message ? e.message : "تعذر تحديث ملخصات الحركة حالياً.";
    return result;
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function ownerRebuildMovementDailySummaries(sessionToken, options) {
  // Owner-authorized deterministic repair of the derived Movement_Daily_Summary
  // rows only. Purchases and Transfers are read for aggregation and are never
  // modified. The pending transfer index is not touched by this operation.
  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    ensureRuntimeSchemaReady_();
    const ss = adminContext.ss;
    const owner = adminContext.owner || {};
    const opts = options || {};
    const dryRun = opts.dryRun === true;
    const now = new Date();
    const result = rebuildMovementDailySummariesInternal_(ss, { dryRun: dryRun });
    try {
      logActionDetail_("OWNER_REBUILD_MOVEMENT_SUMMARIES", "Owner rebuilt movement daily summaries", {
        entityType: "movement_summary",
        user: owner.employeeNumber || "",
        dryRun: dryRun,
        success: result.success,
        rebuilt: result.rebuilt,
        exactMatch: result.exactMatch,
        expectedKeyCount: result.expectedKeyCount,
        actualKeyCount: result.actualKeyCount,
        duplicatesBefore: result.duplicatesBefore,
        missingBefore: result.missingBefore,
        unexpectedBefore: result.unexpectedBefore,
        duplicatesAfter: result.duplicatesAfter,
        missingAfter: result.missingAfter,
        unexpectedAfter: result.unexpectedAfter,
        rowsWritten: result.rowsWritten,
        rowsCleared: result.rowsCleared
      }, getSheetByNameCaseInsensitive_(ss, "Logs"), now);
    } catch (logError) {
      console.error("ownerRebuildMovementDailySummaries logging failed", logError);
    }
    return result;
  } catch (e) {
    console.error("ownerRebuildMovementDailySummaries failed", e);
    return {
      success: false,
      rebuilt: false,
      dryRun: false,
      expectedKeyCount: 0,
      actualKeyCount: 0,
      missingBefore: 0,
      unexpectedBefore: 0,
      duplicatesBefore: 0,
      malformedBefore: 0,
      quantityMismatchesBefore: 0,
      costMismatchesBefore: 0,
      missingAfter: 0,
      unexpectedAfter: 0,
      duplicatesAfter: 0,
      malformedAfter: 0,
      quantityMismatchesAfter: 0,
      costMismatchesAfter: 0,
      rowsWritten: 0,
      rowsCleared: 0,
      exactMatch: false,
      warning: "",
      message: "تعذر إصلاح ملخصات الحركة حالياً."
    };
  }
}

function ownerRebuildPendingTransferIndex(sessionToken) {
  // Owner-authorized repair for the derived pending index only. Movement
  // summaries are deliberately not touched by this operation.
  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    ensureRuntimeSchemaReady_();
    const ss = adminContext.ss;
    const owner = adminContext.owner || {};
    const now = new Date();
    const result = rebuildPendingTransferIndexInternal_(ss, {});
    try {
      logActionDetail_("OWNER_REBUILD_PENDING_TRANSFER_INDEX", "Owner rebuilt the pending transfer index", {
        entityType: "pending_transfer_index",
        user: owner.employeeNumber || "",
        success: result.success,
        rebuilt: result.rebuilt,
        exactMatch: result.exactMatch,
        sourcePendingRows: result.sourcePendingRows,
        indexedPendingRows: result.indexedPendingRows,
        missingBefore: result.missingBefore,
        staleBefore: result.staleBefore,
        duplicatesBefore: result.duplicatesBefore,
        missingAfter: result.missingAfter,
        staleAfter: result.staleAfter,
        duplicatesAfter: result.duplicatesAfter
      }, getSheetByNameCaseInsensitive_(ss, "Logs"), now);
    } catch (logError) {
      console.error("ownerRebuildPendingTransferIndex logging failed", logError);
    }
    return result;
  } catch (e) {
    console.error("ownerRebuildPendingTransferIndex failed", e);
    return {
      success: false,
      rebuilt: false,
      sourcePendingRows: 0,
      indexedPendingRows: 0,
      missingBefore: 0,
      staleBefore: 0,
      duplicatesBefore: 0,
      missingAfter: 0,
      staleAfter: 0,
      duplicatesAfter: 0,
      supersededRows: 0,
      appendedRows: 0,
      exactMatch: false,
      warning: "",
      message: "تعذر إعادة بناء فهرس التحويلات المعلقة حالياً."
    };
  }
}


// ==================================================
// PHASE 5 — MANAGER FEATURE VISIBILITY
// ==================================================

function shouldUseRecentOwnerReportScan_(rangeInfo) {
  return !!(rangeInfo && rangeInfo.isDefaulted === true);
}

function getOwnerReportRows_(sheet, headerMap, rangeInfo, recentLimit) {
  const lastRow = sheet.getLastRow();
  const totalRows = Math.max(0, lastRow - 1);
  const limit = Math.max(1, parseInt(recentLimit, 10) || 5000);
  if (totalRows === 0) {
    return { values: [], scanLimited: false, scanLimit: limit, scannedRows: 0, totalRows: 0, usedRecentScan: shouldUseRecentOwnerReportScan_(rangeInfo) };
  }
  if (shouldUseRecentOwnerReportScan_(rangeInfo)) {
    const recentRows = getRecentSheetRows_(sheet, headerMap, limit);
    return {
      values: recentRows.values,
      scanLimited: totalRows > recentRows.values.length,
      scanLimit: limit,
      scannedRows: recentRows.values.length,
      totalRows: totalRows,
      usedRecentScan: true
    };
  }
  return {
    values: sheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues(),
    scanLimited: false,
    scanLimit: "",
    scannedRows: totalRows,
    totalRows: totalRows,
    usedRecentScan: false
  };
}

function formatMovementSummaryDate_(value) {
  const date = parseSheetDate_(value);
  if (!date) return "";
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function formatMovementSummaryMonth_(value) {
  const dateText = formatMovementSummaryDate_(value);
  return dateText ? dateText.substring(0, 7) : "";
}

function mergeMovementSummaryEntry_(target, entry) {
  target.quantity_in += Number(entry.quantity_in || 0);
  target.quantity_out += Number(entry.quantity_out || 0);
  target.net_quantity += Number(entry.net_quantity || 0);
  target.purchase_count += Number(entry.purchase_count || 0);
  target.transfer_count += Number(entry.transfer_count || 0);
  target.pending_count += Number(entry.pending_count || 0);
  target.approved_count += Number(entry.approved_count || 0);
  target.missing_count += Number(entry.missing_count || 0);
  target.zero_receipt_count += Number(entry.zero_receipt_count || 0);
  target.total_cost += Number(entry.total_cost || 0);
  target.last_source_row = Math.max(Number(target.last_source_row || 0), Number(entry.last_source_row || 0));
  const entryUpdated = parseSheetDate_(entry.last_source_updated_at);
  const targetUpdated = parseSheetDate_(target.last_source_updated_at);
  if (entryUpdated && (!targetUpdated || entryUpdated.getTime() >= targetUpdated.getTime())) {
    target.last_source_updated_at = entry.last_source_updated_at;
  }
}

function upsertMovementDailySummaries_(ss, entries, options) {
  const opts = options || {};
  const now = opts.updatedAt || new Date();
  const sheet = getSheetByNameCaseInsensitive_(ss, "Movement_Daily_Summary");
  if (!sheet || !entries || !entries.length) return { rowsWritten: 0 };
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Movement_Daily_Summary);
  const grouped = {};
  entries.forEach(function(entry) {
    const normalized = normalizeMovementSummaryEntry_(entry, now);
    if (!normalized.summary_date || !normalized.branch_id || !normalized.item_id || !normalized.source_type || !normalized.movement_type) return;
    const key = getMovementSummaryKey_(normalized);
    if (!grouped[key]) {
      grouped[key] = normalized;
    } else {
      mergeMovementSummaryEntry_(grouped[key], normalized);
    }
  });

  const keys = Object.keys(grouped);
  if (!keys.length) return { rowsWritten: 0 };

  const existing = {};
  const summaryDates = Object.create(null);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const data = sheet.getRange(2, 1, lastRow - 1, headerMap.__lastColumn).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rawDate = getCellByHeader_(row, headerMap, "summary_date");
      const dateKey = rawDate instanceof Date ? 'date:' + rawDate.getTime() : typeof rawDate + ':' + String(rawDate);
      if (!Object.prototype.hasOwnProperty.call(summaryDates,dateKey)) summaryDates[dateKey] = canonicalMovementSummaryDateKey_(rawDate);
      const key = buildMovementSummaryKeyFromRow_(row, headerMap, summaryDates[dateKey]);
      if (!isCompleteMovementSummaryKey_(key)) continue;
      // If corrupt duplicate rows already exist, bind to the first occurrence
      // so an update never appends yet another logical duplicate. Removing the
      // extra rows is the rebuild's job.
      if (existing[key]) continue;
      existing[key] = { rowNumber: i + 2, row: row };
    }
  }

  const updates = [];
  const appends = [];
  keys.forEach(function(key) {
    const entry = grouped[key];
    const existingRecord = existing[key];
    if (existingRecord) {
      const existingLastSourceRow = Number(getCellByHeader_(existingRecord.row, headerMap, "last_source_row") || 0);
      if (entry.last_source_row && existingLastSourceRow && entry.last_source_row <= existingLastSourceRow) {
        return;
      }
      const rowObj = {
        summary_date: canonicalMovementSummaryDateKey_(getCellByHeader_(existingRecord.row, headerMap, "summary_date")),
        period_month: getCellByHeader_(existingRecord.row, headerMap, "period_month"),
        branch_id: getCellByHeader_(existingRecord.row, headerMap, "branch_id"),
        item_id: getCellByHeader_(existingRecord.row, headerMap, "item_id"),
        source_type: getCellByHeader_(existingRecord.row, headerMap, "source_type"),
        movement_type: getCellByHeader_(existingRecord.row, headerMap, "movement_type"),
        quantity_in: Number(getCellByHeader_(existingRecord.row, headerMap, "quantity_in") || 0),
        quantity_out: Number(getCellByHeader_(existingRecord.row, headerMap, "quantity_out") || 0),
        net_quantity: Number(getCellByHeader_(existingRecord.row, headerMap, "net_quantity") || 0),
        purchase_count: Number(getCellByHeader_(existingRecord.row, headerMap, "purchase_count") || 0),
        transfer_count: Number(getCellByHeader_(existingRecord.row, headerMap, "transfer_count") || 0),
        pending_count: Number(getCellByHeader_(existingRecord.row, headerMap, "pending_count") || 0),
        approved_count: Number(getCellByHeader_(existingRecord.row, headerMap, "approved_count") || 0),
        missing_count: Number(getCellByHeader_(existingRecord.row, headerMap, "missing_count") || 0),
        zero_receipt_count: Number(getCellByHeader_(existingRecord.row, headerMap, "zero_receipt_count") || 0),
        total_cost: Number(getCellByHeader_(existingRecord.row, headerMap, "total_cost") || 0),
        last_source_row: existingLastSourceRow,
        last_source_updated_at: getCellByHeader_(existingRecord.row, headerMap, "last_source_updated_at"),
        updated_at: now
      };
      mergeMovementSummaryEntry_(rowObj, entry);
      rowObj.updated_at = now;
      updates.push({ rowNumber: existingRecord.rowNumber, row: buildRowByHeaders_(headerMap, rowObj) });
    } else {
      appends.push(buildRowByHeaders_(headerMap, entry));
    }
  });

  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, headerMap.__lastColumn).setValues([update.row]);
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, headerMap.__lastColumn).setValues(appends);
  }
  return { rowsWritten: updates.length + appends.length };
}

// ==================================================
// MOVEMENT DAILY SUMMARY — EXACT RECONCILIATION
// ==================================================
//
// Purchases and Transfers are the source of truth. Movement_Daily_Summary is
// derived: it is current derived state, not append-only history, so a rebuild
// deterministically replaces the whole data region. Duplicate logical rows are
// corruption, never history, and are never preserved.

var MOVEMENT_SUMMARY_NUMERIC_FIELDS = [
  "quantity_in",
  "quantity_out",
  "net_quantity",
  "purchase_count",
  "transfer_count",
  "pending_count",
  "approved_count",
  "missing_count",
  "zero_receipt_count"
];
var MOVEMENT_SUMMARY_EPSILON = 0.000001;

function buildMovementSummaryKeyFromRow_(row, headerMap, normalizedSummaryDate) {
  return getMovementSummaryKey_({
    summary_date: normalizedSummaryDate === undefined ? getCellByHeader_(row, headerMap, "summary_date") : normalizedSummaryDate,
    branch_id: getCellByHeader_(row, headerMap, "branch_id"),
    item_id: getCellByHeader_(row, headerMap, "item_id"),
    source_type: getCellByHeader_(row, headerMap, "source_type"),
    movement_type: getCellByHeader_(row, headerMap, "movement_type")
  });
}

function movementSummaryNumbersMatch_(actual, expected) {
  const a = Number(actual || 0);
  const b = Number(expected || 0);
  if (isNaN(a) || isNaN(b)) return false;
  return Math.abs(a - b) <= MOVEMENT_SUMMARY_EPSILON;
}

// Deterministic expected state derived from the raw operational sheets. It
// reuses the same entry builders the incremental write path uses, so health can
// never flag a correctly maintained summary as drifted.
function buildExpectedMovementSummaryMapR01Read_(ss, now) {
  const timestamp = now || new Date();
  const expected = { byKey: {}, count: 0, purchaseRows: 0, transferRows: 0, skippedRows: 0 };

  function addEntry_(entry) {
    if (!entry) return;
    const normalized = normalizeMovementSummaryEntry_(entry, timestamp);
    const key = getMovementSummaryKey_(normalized);
    if (!isCompleteMovementSummaryKey_(key)) {
      expected.skippedRows++;
      return;
    }
    if (!expected.byKey[key]) {
      expected.byKey[key] = normalized;
      expected.count++;
      return;
    }
    mergeMovementSummaryEntry_(expected.byKey[key], normalized);
  }

  const purchasesSheet = getSheetByNameCaseInsensitive_(ss, "Purchases");
  if (purchasesSheet && purchasesSheet.getLastRow() > 1) {
    const headerMap = requireHeaderColumns_(purchasesSheet, getInventorySchemaRequirements_().Purchases);
    const totalRows = purchasesSheet.getLastRow() - 1;
    const data = purchasesSheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
    for (let i = 0; i < data.length; i++) {
      expected.purchaseRows++;
      addEntry_(buildPurchaseSummaryEntryFromRow_(data[i], headerMap, i + 2, timestamp));
    }
  }

  const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  if (transfersSheet && transfersSheet.getLastRow() > 1) {
    const headerMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);
    const totalRows = transfersSheet.getLastRow() - 1;
    const data = transfersSheet.getRange(2, 1, totalRows, headerMap.__lastColumn).getValues();
    for (let i = 0; i < data.length; i++) {
      const sourceRow = i + 2;
      expected.transferRows++;
      // "created" always applies; "received" adds the incoming movement only
      // for approved/missing rows, so pending transfers never become stock.
      buildTransferSummaryEntriesFromRow_(data[i], headerMap, sourceRow, timestamp, "created").forEach(addEntry_);
      buildTransferSummaryEntriesFromRow_(data[i], headerMap, sourceRow, timestamp, "received").forEach(addEntry_);
    }
  }

  return expected;
}

function buildActualMovementSummaryMap_(rows, headerMap) {
  const actual = {
    byKey: {},
    count: 0,
    duplicateRows: 0,
    duplicateKeys: [],
    duplicateRowNumbers: [],
    malformedRows: 0,
    malformedRowNumbers: []
  };
  (rows || []).forEach(function(row, offset) {
    const rowNumber = offset + 2;
    const key = buildMovementSummaryKeyFromRow_(row, headerMap);
    if (!isCompleteMovementSummaryKey_(key)) {
      actual.malformedRows++;
      actual.malformedRowNumbers.push(rowNumber);
      return;
    }
    if (actual.byKey[key]) {
      actual.duplicateRows++;
      actual.duplicateRowNumbers.push(rowNumber);
      if (actual.duplicateKeys.indexOf(key) === -1) actual.duplicateKeys.push(key);
      return;
    }
    const record = { key: key, rowNumber: rowNumber };
    MOVEMENT_SUMMARY_NUMERIC_FIELDS.forEach(function(field) {
      record[field] = Number(getCellByHeader_(row, headerMap, field) || 0);
    });
    record.total_cost = Number(getCellByHeader_(row, headerMap, "total_cost") || 0);
    record.branch_id = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    record.source_type = String(getCellByHeader_(row, headerMap, "source_type") || "").trim().toLowerCase();
    actual.byKey[key] = record;
    actual.count++;
  });
  return actual;
}

function compareMovementSummaryState_(expected, actual) {
  const missingKeys = [];
  const unexpectedKeys = [];
  const quantityMismatchKeys = [];
  const costMismatchKeys = [];
  const perSourceType = {};
  const perBranch = {};

  function bucket_(store, id) {
    const name = String(id || "");
    if (!store[name]) {
      store[name] = { id: name, expectedKeys: 0, actualKeys: 0, missingKeys: 0, unexpectedKeys: 0, mismatchedKeys: 0 };
    }
    return store[name];
  }

  Object.keys(expected.byKey || {}).forEach(function(key) {
    const entry = expected.byKey[key];
    bucket_(perSourceType, entry.source_type).expectedKeys++;
    bucket_(perBranch, entry.branch_id).expectedKeys++;
    const actualRecord = actual.byKey[key];
    if (!actualRecord) {
      missingKeys.push(key);
      bucket_(perSourceType, entry.source_type).missingKeys++;
      bucket_(perBranch, entry.branch_id).missingKeys++;
      return;
    }
    let quantityOk = true;
    MOVEMENT_SUMMARY_NUMERIC_FIELDS.forEach(function(field) {
      if (!movementSummaryNumbersMatch_(actualRecord[field], entry[field])) quantityOk = false;
    });
    const costOk = movementSummaryNumbersMatch_(actualRecord.total_cost, entry.total_cost);
    if (!quantityOk) quantityMismatchKeys.push(key);
    if (!costOk) costMismatchKeys.push(key);
    if (!quantityOk || !costOk) {
      bucket_(perSourceType, entry.source_type).mismatchedKeys++;
      bucket_(perBranch, entry.branch_id).mismatchedKeys++;
    }
  });

  Object.keys(actual.byKey || {}).forEach(function(key) {
    const record = actual.byKey[key];
    bucket_(perSourceType, record.source_type).actualKeys++;
    bucket_(perBranch, record.branch_id).actualKeys++;
    if (expected.byKey[key]) return;
    unexpectedKeys.push(key);
    bucket_(perSourceType, record.source_type).unexpectedKeys++;
    bucket_(perBranch, record.branch_id).unexpectedKeys++;
  });

  const duplicateRows = Number(actual.duplicateRows || 0);
  const malformedRows = Number(actual.malformedRows || 0);
  // Exact key-set AND numeric equality. A matching row count is never enough.
  const exactMatch =
    missingKeys.length === 0 &&
    unexpectedKeys.length === 0 &&
    quantityMismatchKeys.length === 0 &&
    costMismatchKeys.length === 0 &&
    duplicateRows === 0 &&
    malformedRows === 0 &&
    expected.count === actual.count;

  const sourceTypeMismatches = [];
  Object.keys(perSourceType).forEach(function(id) {
    const b = perSourceType[id];
    if (b.missingKeys || b.unexpectedKeys || b.mismatchedKeys || b.expectedKeys !== b.actualKeys) {
      sourceTypeMismatches.push(b);
    }
  });
  const branchMismatches = [];
  Object.keys(perBranch).forEach(function(id) {
    const b = perBranch[id];
    if (b.missingKeys || b.unexpectedKeys || b.mismatchedKeys || b.expectedKeys !== b.actualKeys) {
      branchMismatches.push(b);
    }
  });

  return {
    exactMatch: exactMatch,
    expectedKeyCount: expected.count,
    actualKeyCount: actual.count,
    missingKeyCount: missingKeys.length,
    unexpectedKeyCount: unexpectedKeys.length,
    duplicateKeyCount: (actual.duplicateKeys || []).length,
    duplicateRowCount: duplicateRows,
    malformedRowCount: malformedRows,
    quantityMismatchCount: quantityMismatchKeys.length,
    costMismatchCount: costMismatchKeys.length,
    missingKeys: missingKeys,
    unexpectedKeys: unexpectedKeys,
    quantityMismatchKeys: quantityMismatchKeys,
    costMismatchKeys: costMismatchKeys,
    perSourceType: perSourceType,
    perBranch: perBranch,
    sourceTypeMismatches: sourceTypeMismatches,
    branchMismatches: branchMismatches
  };
}

function readMovementSummaryRows_(sheet, headerMap) {
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, headerMap.__lastColumn).getValues();
}

function reconcileMovementSummaryState_(ss, now) {
  const summarySheet = getSheetByNameCaseInsensitive_(ss, "Movement_Daily_Summary");
  if (!summarySheet) {
    return { available: false, reason: "summary_sheet_missing" };
  }
  const headerMap = requireHeaderColumns_(summarySheet, getInventorySchemaRequirements_().Movement_Daily_Summary);
  const expected = buildExpectedMovementSummaryMap_(ss, now);
  const rows = readMovementSummaryRows_(summarySheet, headerMap);
  const actual = buildActualMovementSummaryMap_(rows, headerMap);
  return {
    available: true,
    summarySheet: summarySheet,
    headerMap: headerMap,
    rows: rows,
    expected: expected,
    actual: actual,
    comparison: compareMovementSummaryState_(expected, actual)
  };
}

function buildMovementSummaryRebuildReport_(comparison, extra) {
  const c = comparison || {};
  const report = {
    success: false,
    rebuilt: false,
    dryRun: false,
    expectedKeyCount: Number(c.expectedKeyCount || 0),
    actualKeyCount: Number(c.actualKeyCount || 0),
    missingBefore: 0,
    unexpectedBefore: 0,
    duplicatesBefore: 0,
    malformedBefore: 0,
    quantityMismatchesBefore: 0,
    costMismatchesBefore: 0,
    missingAfter: 0,
    unexpectedAfter: 0,
    duplicatesAfter: 0,
    malformedAfter: 0,
    quantityMismatchesAfter: 0,
    costMismatchesAfter: 0,
    rowsWritten: 0,
    rowsCleared: 0,
    exactMatch: false,
    warning: "",
    message: ""
  };
  Object.keys(extra || {}).forEach(function(key) { report[key] = extra[key]; });
  return report;
}

function buildSortedMovementSummaryRows_(expected, headerMap) {
  const keys = Object.keys(expected.byKey || {}).sort();
  return keys.map(function(key) {
    return buildRowByHeaders_(headerMap, expected.byKey[key]);
  });
}

// Owner-authorized deterministic replacement of the derived summary region.
// Raw Purchases and Transfers rows are never read for anything but aggregation
// and are never modified.
function rebuildMovementDailySummariesInternal_(ss, options) {
  const opts = options || {};
  const dryRun = opts.dryRun === true;
  const maxAttempts = Math.max(1, parseInt(opts.maxAttempts, 10) || 2);
  const lock = LockService.getScriptLock();
  let lastReport = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let lockAcquired = false;
    try {
      const now = new Date();
      // Heavy raw aggregation happens outside the final write lock.
      const versionAtRead = getBalanceSourceVersion_();
      const before = reconcileMovementSummaryState_(ss, now);
      if (!before.available) {
        return buildMovementSummaryRebuildReport_(null, {
          message: "جدول ملخصات الحركة غير موجود. الرجاء تشغيل تحديث بنية الجداول أولاً."
        });
      }
      const beforeComparison = before.comparison;

      if (dryRun) {
        return buildMovementSummaryRebuildReport_(beforeComparison, {
          success: true,
          rebuilt: false,
          dryRun: true,
          missingBefore: beforeComparison.missingKeyCount,
          unexpectedBefore: beforeComparison.unexpectedKeyCount,
          duplicatesBefore: beforeComparison.duplicateRowCount,
          malformedBefore: beforeComparison.malformedRowCount,
          quantityMismatchesBefore: beforeComparison.quantityMismatchCount,
          costMismatchesBefore: beforeComparison.costMismatchCount,
          exactMatch: beforeComparison.exactMatch,
          message: beforeComparison.exactMatch
            ? "ملخصات الحركة مطابقة للبيانات الأصلية."
            : "ملخصات الحركة غير مطابقة للبيانات الأصلية ويلزم إصلاحها."
        });
      }

      const expectedRows = buildSortedMovementSummaryRows_(before.expected, before.headerMap);

      lock.waitLock(15000);
      lockAcquired = true;

      if (getBalanceSourceVersion_() !== versionAtRead) {
        // A purchase, transfer, or receipt landed while aggregating.
        SpreadsheetApp.flush();
        lockAcquired = false;
        lock.releaseLock();
        continue;
      }

      const previousRowCount = Math.max(0, before.summarySheet.getLastRow() - 1);
      if (expectedRows.length) {
        before.summarySheet
          .getRange(2, 1, expectedRows.length, before.headerMap.__lastColumn)
          .setValues(expectedRows);
      }
      let rowsCleared = 0;
      if (previousRowCount > expectedRows.length) {
        rowsCleared = previousRowCount - expectedRows.length;
        before.summarySheet
          .getRange(expectedRows.length + 2, 1, rowsCleared, before.headerMap.__lastColumn)
          .clearContent();
      }
      SpreadsheetApp.flush();

      const after = reconcileMovementSummaryState_(ss, now);
      const sourceStable = getBalanceSourceVersion_() === versionAtRead;
      const afterComparison = after.comparison;
      const exactMatch = !!afterComparison.exactMatch && sourceStable;

      lastReport = buildMovementSummaryRebuildReport_(afterComparison, {
        success: exactMatch,
        rebuilt: true,
        missingBefore: beforeComparison.missingKeyCount,
        unexpectedBefore: beforeComparison.unexpectedKeyCount,
        duplicatesBefore: beforeComparison.duplicateRowCount,
        malformedBefore: beforeComparison.malformedRowCount,
        quantityMismatchesBefore: beforeComparison.quantityMismatchCount,
        costMismatchesBefore: beforeComparison.costMismatchCount,
        missingAfter: afterComparison.missingKeyCount,
        unexpectedAfter: afterComparison.unexpectedKeyCount,
        duplicatesAfter: afterComparison.duplicateRowCount,
        malformedAfter: afterComparison.malformedRowCount,
        quantityMismatchesAfter: afterComparison.quantityMismatchCount,
        costMismatchesAfter: afterComparison.costMismatchCount,
        rowsWritten: expectedRows.length,
        rowsCleared: rowsCleared,
        exactMatch: exactMatch,
        warning: exactMatch ? "" : "تعذر إثبات تطابق الملخصات مع البيانات الأصلية بعد الإصلاح. الرجاء إعادة المحاولة.",
        message: exactMatch
          ? "تم إصلاح ملخصات الحركة والتحقق من مطابقتها للبيانات الأصلية."
          : "تمت محاولة الإصلاح، لكن لم يتم إثبات التطابق التام. لم يتم اعتماد الملخصات كسليمة."
      });

      lockAcquired = false;
      lock.releaseLock();

      if (exactMatch) return lastReport;
    } catch (error) {
      console.error("rebuildMovementDailySummariesInternal_ failed", error);
      return buildMovementSummaryRebuildReport_(null, {
        message: getSafeWriteErrorMessage_(error)
      });
    } finally {
      if (lockAcquired) lock.releaseLock();
    }
  }

  if (lastReport) return lastReport;
  return buildMovementSummaryRebuildReport_(null, {
    message: "تعذر إصلاح الملخصات بسبب تغير البيانات أثناء العملية. الرجاء المحاولة مرة أخرى."
  });
}

function buildPurchaseSummaryEntryFromRow_(row, headerMap, sourceRow, now) {
  const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
  if (!createdAt) return null;
  const qty = Number(getCellByHeader_(row, headerMap, "normalized_quantity") || 0);
  return {
    summary_date: formatMovementSummaryDate_(createdAt),
    period_month: formatMovementSummaryMonth_(createdAt),
    branch_id: String(getCellByHeader_(row, headerMap, "branch") || "").trim(),
    item_id: String(getCellByHeader_(row, headerMap, "item_id") || "").trim(),
    source_type: "purchase",
    movement_type: "local_purchase",
    quantity_in: qty,
    quantity_out: 0,
    net_quantity: qty,
    purchase_count: 1,
    total_cost: Number(getCellByHeader_(row, headerMap, "cost") || 0),
    last_source_row: sourceRow,
    last_source_updated_at: createdAt,
    updated_at: now || new Date()
  };
}

function buildTransferSummaryEntriesFromRow_(row, headerMap, sourceRow, now, mode) {
  const createdAt = parseSheetDate_(getCellByHeader_(row, headerMap, "created_at"));
  if (!createdAt) return [];
  const status = String(getCellByHeader_(row, headerMap, "status") || "").trim().toLowerCase();
  const targetBranch = String(getCellByHeader_(row, headerMap, "branch") || "").trim();
  let sourceBranch = String(getCellByHeader_(row, headerMap, "source_branch") || "").trim();
  if (!sourceBranch) sourceBranch = "DISTRIBUTOR";
  const itemId = String(getCellByHeader_(row, headerMap, "item_id") || "").trim();
  const qty = Number(getCellByHeader_(row, headerMap, "normalized_quantity") || 0);
  const cost = Number(getCellByHeader_(row, headerMap, "cost") || 0);
  const entries = [];
  if (!mode || mode === "created") {
    if (sourceBranch && sourceBranch !== "DISTRIBUTOR") {
      entries.push({
        summary_date: formatMovementSummaryDate_(createdAt),
        period_month: formatMovementSummaryMonth_(createdAt),
        branch_id: sourceBranch,
        item_id: itemId,
        source_type: "transfer",
        movement_type: "outgoing_branch_transfer",
        quantity_in: 0,
        quantity_out: qty,
        net_quantity: -qty,
        transfer_count: 1,
        total_cost: cost,
        last_source_row: sourceRow,
        last_source_updated_at: createdAt,
        updated_at: now || new Date()
      });
    }
    entries.push({
      summary_date: formatMovementSummaryDate_(createdAt),
      period_month: formatMovementSummaryMonth_(createdAt),
      branch_id: targetBranch,
      item_id: itemId,
      source_type: "transfer",
      movement_type: "incoming_pending",
      quantity_in: 0,
      quantity_out: 0,
      net_quantity: 0,
      transfer_count: 1,
      pending_count: status === "pending" ? 1 : 0,
      total_cost: cost,
      last_source_row: sourceRow,
      last_source_updated_at: createdAt,
      updated_at: now || new Date()
    });
  }
  if (mode === "received" && (status === "approved" || status === "missing")) {
    const receivedAt = parseSheetDate_(getCellByHeader_(row, headerMap, "received_at")) || now || new Date();
    const receivedQty = getReceivedNormalizedQuantityForBalance_(row, headerMap);
    const balanceQty = receivedQty === null ? qty : receivedQty;
    entries.push({
      summary_date: formatMovementSummaryDate_(receivedAt),
      period_month: formatMovementSummaryMonth_(receivedAt),
      branch_id: targetBranch,
      item_id: itemId,
      source_type: "transfer",
      movement_type: "incoming_received",
      quantity_in: balanceQty,
      quantity_out: 0,
      net_quantity: balanceQty,
      transfer_count: 0,
      approved_count: status === "approved" ? 1 : 0,
      missing_count: status === "missing" ? 1 : 0,
      zero_receipt_count: balanceQty === 0 ? 1 : 0,
      last_source_row: sourceRow,
      last_source_updated_at: receivedAt,
      updated_at: now || new Date()
    });
  }
  return entries;
}

// ==================================================
// PENDING TRANSFER INDEX — DETERMINISTIC IDENTITY
// ==================================================
//
// Canonical pending identity:
//   transfer_row | transfer_id | branch_id (destination) | item_id
//
// `transfer_row` pins the exact physical Transfers row, and the business
// triple proves that row still holds the same transfer line. Neither part is
// sufficient alone: one transfer_id spans several item rows in a bulk
// transfer, one item_id repeats across transfers, and a row number alone
// carries no proof that the row still holds the indexed record. A maximum row
// number is never proof of completeness.

function normalizePendingIndexToken_(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function parsePendingIndexSourceRowNumber_(value) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 2 ? 0 : parsed;
}

function isPendingTransferStatusValue_(value) {
  return normalizePendingIndexToken_(value).toLowerCase() === "pending";
}

function buildPendingTransferIdentityKey_(transferRow, transferId, branchId, itemId) {
  const rowNumber = parsePendingIndexSourceRowNumber_(transferRow);
  const transfer = normalizePendingIndexToken_(transferId);
  const branch = normalizePendingIndexToken_(branchId);
  const item = normalizePendingIndexToken_(itemId);
  if (!rowNumber || !transfer || !branch || !item) return "";
  return rowNumber + "|" + transfer + "|" + branch + "|" + item;
}

function buildPendingTransferIdentityKeyFromSourceRow_(row, transfersHeaderMap, rowNumber) {
  return buildPendingTransferIdentityKey_(
    rowNumber,
    getCellByHeader_(row, transfersHeaderMap, "transfer_id"),
    getCellByHeader_(row, transfersHeaderMap, "branch"),
    getCellByHeader_(row, transfersHeaderMap, "item_id")
  );
}

function buildPendingTransferIdentityKeyFromIndexRow_(row, indexHeaderMap) {
  return buildPendingTransferIdentityKey_(
    getCellByHeader_(row, indexHeaderMap, "transfer_row"),
    getCellByHeader_(row, indexHeaderMap, "transfer_id"),
    getCellByHeader_(row, indexHeaderMap, "branch_id"),
    getCellByHeader_(row, indexHeaderMap, "item_id")
  );
}

function collectPendingTransferSourceRowsR01Read_(transfersSheet, transfersHeaderMap, branchId) {
  const targetBranch = normalizePendingIndexToken_(branchId);
  const result = { rows: [], scannedRows: 0, totalRows: 0 };
  if (!transfersSheet) return result;
  const lastRow = transfersSheet.getLastRow();
  const totalDataRows = Math.max(0, lastRow - 1);
  result.totalRows = totalDataRows;
  if (totalDataRows === 0) return result;
  const values = transfersSheet.getRange(2, 1, totalDataRows, transfersHeaderMap.__lastColumn).getValues();
  result.scannedRows = values.length;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!isPendingTransferStatusValue_(getCellByHeader_(row, transfersHeaderMap, "status"))) continue;
    const rowBranch = normalizePendingIndexToken_(getCellByHeader_(row, transfersHeaderMap, "branch"));
    if (targetBranch && rowBranch !== targetBranch) continue;
    result.rows.push({ rowNumber: i + 2, row: row });
  }
  return result;
}

function buildPendingTransferSourceIdentityMap_(pendingRows, transfersHeaderMap) {
  const map = { byKey: {}, count: 0, perBranch: {}, malformedRows: 0 };
  (pendingRows || []).forEach(function(entry) {
    if (!entry || !entry.row) return;
    const key = buildPendingTransferIdentityKeyFromSourceRow_(entry.row, transfersHeaderMap, entry.rowNumber);
    if (!key) {
      map.malformedRows++;
      return;
    }
    if (map.byKey[key]) return;
    const branchId = normalizePendingIndexToken_(getCellByHeader_(entry.row, transfersHeaderMap, "branch"));
    map.byKey[key] = { key: key, rowNumber: entry.rowNumber, row: entry.row, branchId: branchId };
    map.count++;
    map.perBranch[branchId] = (map.perBranch[branchId] || 0) + 1;
  });
  return map;
}

function buildPendingTransferIndexIdentityMap_(indexData, indexHeaderMap, branchId, transfersLastRow) {
  const targetBranch = normalizePendingIndexToken_(branchId);
  const lastSourceRow = parseInt(transfersLastRow, 10) || 0;
  const map = {
    byKey: {},
    count: 0,
    perBranch: {},
    malformedRows: 0,
    duplicateRows: 0,
    duplicateKeys: [],
    duplicateIndexRowNumbers: [],
    invalidSourceRowCount: 0
  };
  (indexData || []).forEach(function(row, offset) {
    const indexRowNumber = offset + 2;
    const status = normalizePendingIndexToken_(getCellByHeader_(row, indexHeaderMap, "status")).toLowerCase();
    const receiptState = normalizePendingIndexToken_(getCellByHeader_(row, indexHeaderMap, "receipt_state")).toLowerCase();
    // Only rows the index itself still claims as pending participate in the
    // pending set. Processed/superseded history stays untouched.
    if (status !== "pending" || receiptState !== "pending") return;
    const rowBranch = normalizePendingIndexToken_(getCellByHeader_(row, indexHeaderMap, "branch_id"));
    if (targetBranch && rowBranch !== targetBranch) return;
    const key = buildPendingTransferIdentityKeyFromIndexRow_(row, indexHeaderMap);
    if (!key) {
      map.malformedRows++;
      map.duplicateIndexRowNumbers.push(indexRowNumber);
      return;
    }
    if (map.byKey[key]) {
      map.duplicateRows++;
      map.duplicateIndexRowNumbers.push(indexRowNumber);
      if (map.duplicateKeys.indexOf(key) === -1) map.duplicateKeys.push(key);
      return;
    }
    const sourceRowNumber = parsePendingIndexSourceRowNumber_(getCellByHeader_(row, indexHeaderMap, "transfer_row"));
    if (lastSourceRow && sourceRowNumber > lastSourceRow) map.invalidSourceRowCount++;
    map.byKey[key] = {
      key: key,
      indexRowNumber: indexRowNumber,
      sourceRowNumber: sourceRowNumber,
      branchId: rowBranch
    };
    map.count++;
    map.perBranch[rowBranch] = (map.perBranch[rowBranch] || 0) + 1;
  });
  return map;
}

function comparePendingTransferIdentityMaps_(sourceMap, indexMap) {
  const missingKeys = [];
  const staleKeys = [];
  const staleIndexRowNumbers = [];
  const perBranch = {};

  function branchBucket_(branchId) {
    const id = normalizePendingIndexToken_(branchId);
    if (!perBranch[id]) {
      perBranch[id] = { branchId: id, sourcePendingRows: 0, indexedPendingRows: 0, missingPendingRows: 0, stalePendingRows: 0 };
    }
    return perBranch[id];
  }

  Object.keys(sourceMap.perBranch || {}).forEach(function(branchId) {
    branchBucket_(branchId).sourcePendingRows = sourceMap.perBranch[branchId];
  });
  Object.keys(indexMap.perBranch || {}).forEach(function(branchId) {
    branchBucket_(branchId).indexedPendingRows = indexMap.perBranch[branchId];
  });

  Object.keys(sourceMap.byKey || {}).forEach(function(key) {
    if (indexMap.byKey[key]) return;
    missingKeys.push(key);
    branchBucket_(sourceMap.byKey[key].branchId).missingPendingRows++;
  });
  Object.keys(indexMap.byKey || {}).forEach(function(key) {
    if (sourceMap.byKey[key]) return;
    staleKeys.push(key);
    staleIndexRowNumbers.push(indexMap.byKey[key].indexRowNumber);
    branchBucket_(indexMap.byKey[key].branchId).stalePendingRows++;
  });

  const branchMismatches = [];
  Object.keys(perBranch).forEach(function(branchId) {
    const bucket = perBranch[branchId];
    if (bucket.sourcePendingRows !== bucket.indexedPendingRows || bucket.missingPendingRows || bucket.stalePendingRows) {
      branchMismatches.push(bucket);
    }
  });

  const duplicateRows = Number(indexMap.duplicateRows || 0);
  const malformedRows = Number(indexMap.malformedRows || 0);
  // Exact set equality is the only proof of completeness: identical counts are
  // not enough, and a maximum row number is never enough.
  const exactMatch =
    missingKeys.length === 0 &&
    staleKeys.length === 0 &&
    duplicateRows === 0 &&
    malformedRows === 0 &&
    Number(sourceMap.malformedRows || 0) === 0 &&
    sourceMap.count === indexMap.count;

  return {
    exactMatch: exactMatch,
    missingKeys: missingKeys,
    staleKeys: staleKeys,
    staleIndexRowNumbers: staleIndexRowNumbers,
    duplicateIndexRowNumbers: (indexMap.duplicateIndexRowNumbers || []).slice(),
    sourcePendingRows: sourceMap.count,
    indexedPendingRows: indexMap.count,
    missingPendingRows: missingKeys.length,
    stalePendingRows: staleKeys.length,
    duplicatePendingRows: duplicateRows,
    malformedIndexRows: malformedRows,
    invalidSourceRowCount: Number(indexMap.invalidSourceRowCount || 0),
    perBranch: perBranch,
    branchMismatches: branchMismatches
  };
}

function readPendingTransferIndexData_(indexSheet, indexHeaderMap) {
  if (!indexSheet) return [];
  const lastRow = indexSheet.getLastRow();
  if (lastRow < 2) return [];
  return indexSheet.getRange(2, 1, lastRow - 1, indexHeaderMap.__lastColumn).getValues();
}

function reconcilePendingTransferIndexState_(ss, branchId) {
  const transfersSheet = getSheetByNameCaseInsensitive_(ss, "Transfers");
  const indexSheet = getSheetByNameCaseInsensitive_(ss, "Pending_Transfer_Index");
  if (!transfersSheet) {
    return { available: false, reason: "transfers_sheet_missing" };
  }
  const transfersHeaderMap = requireHeaderColumns_(transfersSheet, getInventorySchemaRequirements_().Transfers);
  const sourceScan = collectPendingTransferSourceRows_(transfersSheet, transfersHeaderMap, branchId);
  const sourceMap = buildPendingTransferSourceIdentityMap_(sourceScan.rows, transfersHeaderMap);
  if (!indexSheet) {
    const emptyIndexMap = buildPendingTransferIndexIdentityMap_([], null, branchId, transfersSheet.getLastRow());
    return {
      available: true,
      indexSheetMissing: true,
      transfersSheet: transfersSheet,
      transfersHeaderMap: transfersHeaderMap,
      indexSheet: null,
      indexHeaderMap: null,
      indexData: [],
      sourceScan: sourceScan,
      sourceMap: sourceMap,
      indexMap: emptyIndexMap,
      comparison: comparePendingTransferIdentityMaps_(sourceMap, emptyIndexMap)
    };
  }
  const indexHeaderMap = requireHeaderColumns_(indexSheet, getInventorySchemaRequirements_().Pending_Transfer_Index);
  const indexData = readPendingTransferIndexData_(indexSheet, indexHeaderMap);
  const indexMap = buildPendingTransferIndexIdentityMap_(indexData, indexHeaderMap, branchId, transfersSheet.getLastRow());
  return {
    available: true,
    indexSheetMissing: false,
    transfersSheet: transfersSheet,
    transfersHeaderMap: transfersHeaderMap,
    indexSheet: indexSheet,
    indexHeaderMap: indexHeaderMap,
    indexData: indexData,
    sourceScan: sourceScan,
    sourceMap: sourceMap,
    indexMap: indexMap,
    comparison: comparePendingTransferIdentityMaps_(sourceMap, indexMap)
  };
}

function supersedePendingTransferIndexRows_(indexSheet, indexHeaderMap, indexRowNumbers, now) {
  const rowNumbers = [];
  (indexRowNumbers || []).forEach(function(value) {
    const rowNumber = parseInt(value, 10);
    if (isNaN(rowNumber) || rowNumber < 2 || rowNumbers.indexOf(rowNumber) !== -1) return;
    rowNumbers.push(rowNumber);
  });
  if (!rowNumbers.length) return 0;
  rowNumbers.sort(function(a, b) { return a - b; });

  const receiptStateColumn = getHeaderIndex_(indexHeaderMap, "receipt_state");
  const updatedAtColumn = getHeaderIndex_(indexHeaderMap, "updated_at");
  if (!receiptStateColumn) {
    throw new Error("Pending_Transfer_Index receipt_state column is missing.");
  }
  const startRow = rowNumbers[0];
  const endRow = rowNumbers[rowNumbers.length - 1];
  const rowCount = endRow - startRow + 1;

  // Historical index rows are never deleted; they are superseded in place so
  // they stop participating in the pending set.
  const receiptStateRange = indexSheet.getRange(startRow, receiptStateColumn, rowCount, 1);
  const receiptStates = receiptStateRange.getValues();
  const updatedAtRange = updatedAtColumn ? indexSheet.getRange(startRow, updatedAtColumn, rowCount, 1) : null;
  const updatedAtValues = updatedAtRange ? updatedAtRange.getValues() : null;
  rowNumbers.forEach(function(rowNumber) {
    const offset = rowNumber - startRow;
    receiptStates[offset][0] = "superseded";
    if (updatedAtValues) updatedAtValues[offset][0] = now || new Date();
  });
  receiptStateRange.setValues(receiptStates);
  if (updatedAtRange && updatedAtValues) updatedAtRange.setValues(updatedAtValues);
  return rowNumbers.length;
}

function buildPendingTransferIndexRebuildReport_(state, extra) {
  const comparison = (state && state.comparison) || {};
  const report = {
    success: false,
    rebuilt: false,
    sourcePendingRows: Number(comparison.sourcePendingRows || 0),
    indexedPendingRows: Number(comparison.indexedPendingRows || 0),
    missingBefore: 0,
    staleBefore: 0,
    duplicatesBefore: 0,
    missingAfter: 0,
    staleAfter: 0,
    duplicatesAfter: 0,
    supersededRows: 0,
    appendedRows: 0,
    exactMatch: false,
    warning: "",
    message: ""
  };
  Object.keys(extra || {}).forEach(function(key) { report[key] = extra[key]; });
  return report;
}

function rebuildPendingTransferIndexInternal_(ss, options) {
  const opts = options || {};
  const maxAttempts = Math.max(1, parseInt(opts.maxAttempts, 10) || 2);
  const lock = LockService.getScriptLock();
  let lastReport = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let lockAcquired = false;
    try {
      // Heavy reads happen outside the lock; the optimistic source version is
      // revalidated inside it before any write is applied.
      const versionAtRead = getBalanceSourceVersion_();
      const before = reconcilePendingTransferIndexState_(ss, "");
      if (!before.available) {
        return buildPendingTransferIndexRebuildReport_(before, {
          message: "جدول Transfers غير موجود."
        });
      }
      if (before.indexSheetMissing) {
        return buildPendingTransferIndexRebuildReport_(before, {
          message: "جدول Pending_Transfer_Index غير موجود. الرجاء تشغيل تحديث بنية الجداول أولاً."
        });
      }

      const beforeComparison = before.comparison;
      const now = new Date();
      const missingEntries = beforeComparison.missingKeys.map(function(key) {
        const sourceEntry = before.sourceMap.byKey[key];
        return buildPendingTransferIndexEntryFromRow_(
          sourceEntry.row,
          before.transfersHeaderMap,
          sourceEntry.rowNumber,
          now
        );
      });
      const supersedeRowNumbers = beforeComparison.staleIndexRowNumbers
        .concat(beforeComparison.duplicateIndexRowNumbers);

      lock.waitLock(15000);
      lockAcquired = true;

      if (getBalanceSourceVersion_() !== versionAtRead) {
        // Transfer data moved while the plan was being built; drop the plan.
        SpreadsheetApp.flush();
        lockAcquired = false;
        lock.releaseLock();
        continue;
      }

      const supersededRows = supersedePendingTransferIndexRows_(
        before.indexSheet,
        before.indexHeaderMap,
        supersedeRowNumbers,
        now
      );
      const indexWrite = upsertPendingTransferIndexRows_(ss, missingEntries);
      SpreadsheetApp.flush();

      const after = reconcilePendingTransferIndexState_(ss, "");
      const sourceStable = getBalanceSourceVersion_() === versionAtRead;
      const afterComparison = after.comparison;
      const exactMatch = !!afterComparison.exactMatch && sourceStable;

      lastReport = buildPendingTransferIndexRebuildReport_(after, {
        success: exactMatch,
        rebuilt: true,
        missingBefore: beforeComparison.missingPendingRows,
        staleBefore: beforeComparison.stalePendingRows,
        duplicatesBefore: beforeComparison.duplicatePendingRows,
        missingAfter: afterComparison.missingPendingRows,
        staleAfter: afterComparison.stalePendingRows,
        duplicatesAfter: afterComparison.duplicatePendingRows,
        supersededRows: supersededRows,
        appendedRows: indexWrite.rowsWritten || 0,
        exactMatch: exactMatch,
        warning: exactMatch ? "" : "تعذر إثبات تطابق الفهرس مع بيانات التحويلات بعد إعادة البناء. الرجاء إعادة المحاولة.",
        message: exactMatch
          ? "تمت إعادة بناء فهرس التحويلات المعلقة والتحقق من مطابقته لبيانات المصدر."
          : "تمت محاولة إعادة البناء، لكن لم يتم إثبات التطابق التام. لم يتم اعتماد الفهرس كسليم."
      });

      lockAcquired = false;
      lock.releaseLock();

      if (exactMatch) return lastReport;
    } catch (error) {
      console.error("rebuildPendingTransferIndexInternal_ failed", error);
      return buildPendingTransferIndexRebuildReport_(null, {
        message: getSafeWriteErrorMessage_(error)
      });
    } finally {
      if (lockAcquired) lock.releaseLock();
    }
  }

  if (lastReport) return lastReport;
  return buildPendingTransferIndexRebuildReport_(null, {
    message: "تعذر إعادة بناء الفهرس بسبب تغير بيانات التحويلات أثناء العملية. الرجاء المحاولة مرة أخرى."
  });
}

function upsertPendingTransferIndexRows_(ss, entries) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Pending_Transfer_Index");
  if (!sheet || !entries || !entries.length) return { rowsWritten: 0 };
  const headerMap = requireHeaderColumns_(sheet, getInventorySchemaRequirements_().Pending_Transfer_Index);
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const identityWidth = Math.max.apply(null, ['transfer_row','transfer_id','branch_id','item_id'].map(function(name) { return getHeaderIndex_(headerMap,name); }));
    const data = sheet.getRange(2, 1, lastRow - 1, identityWidth).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const key = buildPendingTransferIdentityKeyFromIndexRow_(row, headerMap);
      if (!key || existing[key]) continue;
      existing[key] = { rowNumber: i + 2, row: row };
    }
  }
  const appends = [];
  const updates = [];
  const plannedKeys = {};
  entries.forEach(function(entry) {
    const rowObj = {
      transfer_row: Number(entry.transfer_row || 0),
      transfer_id: normalizePendingIndexToken_(entry.transfer_id),
      branch_id: normalizePendingIndexToken_(entry.branch_id),
      source_branch: normalizePendingIndexToken_(entry.source_branch) || "DISTRIBUTOR",
      item_id: normalizePendingIndexToken_(entry.item_id),
      quantity: entry.quantity,
      unit: entry.unit,
      normalized_quantity: entry.normalized_quantity,
      created_by: entry.created_by,
      created_at: entry.created_at,
      status: normalizePendingIndexToken_(entry.status || "pending").toLowerCase(),
      receipt_state: normalizePendingIndexToken_(entry.receipt_state || "pending").toLowerCase(),
      updated_at: entry.updated_at || new Date()
    };
    const key = buildPendingTransferIdentityKey_(rowObj.transfer_row, rowObj.transfer_id, rowObj.branch_id, rowObj.item_id);
    if (!key) return;
    if (existing[key]) {
      updates.push({ rowNumber: existing[key].rowNumber, row: buildRowByHeaders_(headerMap, rowObj) });
      return;
    }
    // Two entries for the same identity in one batch must never append twice.
    if (plannedKeys[key] !== undefined) {
      appends[plannedKeys[key]] = buildRowByHeaders_(headerMap, rowObj);
      return;
    }
    plannedKeys[key] = appends.length;
    appends.push(buildRowByHeaders_(headerMap, rowObj));
  });
  updates.forEach(function(update) {
    sheet.getRange(update.rowNumber, 1, 1, headerMap.__lastColumn).setValues([update.row]);
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, headerMap.__lastColumn).setValues(appends);
  }
  return { rowsWritten: updates.length + appends.length };
}

function buildPendingTransferIndexEntryFromRow_(row, headerMap, sourceRow, now) {
  return {
    transfer_row: sourceRow,
    transfer_id: getCellByHeader_(row, headerMap, "transfer_id"),
    branch_id: getCellByHeader_(row, headerMap, "branch"),
    source_branch: getCellByHeader_(row, headerMap, "source_branch") || "DISTRIBUTOR",
    item_id: getCellByHeader_(row, headerMap, "item_id"),
    quantity: getCellByHeader_(row, headerMap, "quantity"),
    unit: getCellByHeader_(row, headerMap, "unit"),
    normalized_quantity: getCellByHeader_(row, headerMap, "normalized_quantity"),
    created_by: getCellByHeader_(row, headerMap, "created_by"),
    created_at: getCellByHeader_(row, headerMap, "created_at"),
    status: getCellByHeader_(row, headerMap, "status") || "pending",
    receipt_state: String(getCellByHeader_(row, headerMap, "status") || "pending").trim().toLowerCase() === "pending" ? "pending" : "processed",
    updated_at: now || new Date()
  };
}

function logMovementSummaryFailure_(logsSheet, user, context, error, now) {
  try {
    logActionDetail_("MOVEMENT_SUMMARY_UPDATE_FAILED", "Movement summary/index update failed", {
      entityType: "movement_summary",
      user: user && user.employeeNumber ? user.employeeNumber : "",
      context: context || {},
      message: error && error.message ? error.message : String(error || "")
    }, logsSheet, now || new Date());
  } catch (logError) {
    console.error("MOVEMENT_SUMMARY_UPDATE_FAILED log failed", logError);
  }
}

function getOwnerSummaryRows_(ss, dateRange, targetBranch, sourceType) {
  const sheet = getSheetByNameCaseInsensitive_(ss, "Movement_Daily_Summary");
  if (!sheet || sheet.getLastRow() < 2) {
    return { rows: [], scannedRows: 0, totalRows: 0, usedSummary: false, trustworthy: false, reason: "summary_empty" };
  }
  // Recovery can complete source rows without replaying incremental summaries.
  const reconciled = reconcileMovementSummaryState_(ss, new Date());
  if (!reconciled.available || !reconciled.comparison.exactMatch) {
    return { rows: [], scannedRows: reconciled.rows ? reconciled.rows.length : 0, totalRows: sheet.getLastRow() - 1,
      usedSummary: false, trustworthy: false, reason: "summary_source_mismatch" };
  }
  const headerMap = reconciled.headerMap;
  const totalRows = reconciled.rows.length;
  const data = reconciled.rows;
  const rows = [];
  const normalizedSourceType = String(sourceType || "").trim().toLowerCase();
  // Duplicate logical keys inside the reported scope would double owner totals,
  // and no reader can tell which copy is authoritative. Detect them here and
  // refuse to present the summary as trustworthy. Numeric completeness was checked against raw sources above.
  const seenKeys = {};
  let duplicateKeyCount = 0;
  let malformedRowCount = 0;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowSourceType = String(getCellByHeader_(row, headerMap, "source_type") || "").trim().toLowerCase();
    if (normalizedSourceType && rowSourceType !== normalizedSourceType) continue;
    const rowBranch = String(getCellByHeader_(row, headerMap, "branch_id") || "").trim();
    if (targetBranch && rowBranch !== targetBranch) continue;
    // Malformed rows are classified before the date filter: an unparseable
    // summary_date is itself the malformation, and silently dropping such a
    // row would hide the corruption from the owner.
    const key = buildMovementSummaryKeyFromRow_(row, headerMap);
    if (!isCompleteMovementSummaryKey_(key)) {
      malformedRowCount++;
      continue;
    }
    const summaryDate = parseDateInputStart_(getCellByHeader_(row, headerMap, "summary_date"));
    if (!summaryDate) continue;
    if (summaryDate < dateRange.dateFromStart || summaryDate >= dateRange.dateToExclusive) continue;
    if (seenKeys[key]) {
      duplicateKeyCount++;
      continue;
    }
    seenKeys[key] = true;
    rows.push(row);
  }
  const trustworthy = duplicateKeyCount === 0 && malformedRowCount === 0;
  return {
    rows: rows,
    headerMap: headerMap,
    scannedRows: data.length,
    totalRows: totalRows,
    usedSummary: trustworthy,
    trustworthy: trustworthy,
    duplicateKeyCount: duplicateKeyCount,
    malformedRowCount: malformedRowCount,
    reason: trustworthy ? "" : "summary_duplicate_or_malformed_rows"
  };
}

function isOwnerRawReportRangeAllowed_(dateRange) {
  if (!dateRange || !dateRange.dateFromStart || !dateRange.dateToExclusive) return false;
  const days = Math.ceil((dateRange.dateToExclusive.getTime() - dateRange.dateFromStart.getTime()) / (24 * 60 * 60 * 1000));
  return days > 0 && days <= OWNER_RAW_REPORT_MAX_DAYS;
}

function getOwnerDegradedSummaryMessage_() {
  return "تعذر عرض ملخص الفترة لوجود تكرار في بيانات الملخصات. الرجاء تشغيل إصلاح ملخصات الحركة من شاشة المالك، أو اختيار فترة أقصر لعرض التفاصيل من البيانات الأصلية.";
}

function getOwnerWideRangeMessage_() {
  return "نطاق التقرير واسع جداً. الرجاء اختيار فرع وتاريخ أقصر لا يتجاوز " + OWNER_RAW_REPORT_MAX_DAYS + " يوماً لعرض التفاصيل.";
}

function doGet() {
  return HtmlService.createTemplateFromFile("index")
      .evaluate()
      .setTitle("نظام مخزون الفروع الموحد")
      .addMetaTag("viewport", "width=device-width, initial-scale=1")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function verifyEmployeeLogin(employeeNumber, pinCode) {
  return verifyLogin(employeeNumber, pinCode);
}

function getActiveItemsAndUnitsForUser_(ss, user) {
  const role = normalizeRole_(user && user.role);
  if (["distributor", "manager", "owner"].indexOf(role) === -1) {
    throw new Error("ليست لديك صلاحية لتنفيذ هذه العملية.");
  }
  const refItems = getReferenceItems_(ss);
  const refUnits = getReferenceItemUnits_(ss);
  if (!refItems.sheetExists || !refUnits.sheetExists) {
    throw new Error("جداول المنتجات أو الوحدات غير موجودة.");
  }
  
  // بناء كائن لتجميع الوحدات لكل منتج بسهولة
  // الهيكل المستهدف: { "ITEM-101": { name: "أرز", baseUnit: "حبة", units: [{name: "كرتونة", rate: 10}] } }
  let inventoryCatalog = {};
  
  // 1. قراءة المنتجات
  Object.keys(refItems.byId || {}).forEach(function(itemId) {
    const refItem = refItems.byId[itemId];
    inventoryCatalog[itemId] = {
      id: itemId,
      nameAr: String(refItem.nameAr || "").trim(),
      baseUnit: String(refItem.baseUnit || "").trim(),
      sortOrder: refItem.sortOrder,
      units: [] // سيتم ملؤها من جدول الوحدات
    };
  });
  
  // 2. قراءة الوحدات وربطها بالمنتج المناسب
  Object.keys(refUnits.byItem || {}).forEach(function(unitItemId) {
    if (inventoryCatalog[unitItemId]) {
      refUnits.byItem[unitItemId].forEach(function(unitInfo) {
        const unitName = String(unitInfo.unitName || "").trim();
        if (!unitName || unitName === inventoryCatalog[unitItemId].baseUnit) return;
        inventoryCatalog[unitItemId].units.push({
          unitName: unitName,
          conversionRate: unitInfo.conversionRate
        });
      });
    }
  });
  
  return { success: true, catalog: inventoryCatalog, itemOrder: refItems.itemOrder || [] };
}

function getActiveItemsAndUnits(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager", "owner"]);
    return getActiveItemsAndUnitsForUser_(ss, user);
  } catch (e) {
    console.error("getActiveItemsAndUnits failed", { message: e && e.message ? e.message : String(e) });
    return { success: false, message: "تعذر تحميل بيانات المنتجات. الرجاء تسجيل الدخول مجدداً." };
  }
}

function getActiveBranchesForUser_(ss, user) {
  const role = normalizeRole_(user && user.role);
  if (["distributor", "manager", "owner"].indexOf(role) === -1) {
    throw new Error("ليست لديك صلاحية لتنفيذ هذه العملية.");
  }
  const refBranches = getReferenceBranches_(ss);
  if (!refBranches.sheetExists) {
    return { success: false, message: "جدول branches غير موجود." };
  }

  return { success: true, branches: refBranches.activeBranches || [] };
}

function getActiveBranches(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, ["distributor", "manager", "owner"]);
    return getActiveBranchesForUser_(ss, user);
  } catch (e) {
    console.error("getActiveBranches failed", { message: e && e.message ? e.message : String(e) });
    return { success: false, message: "تعذر تحميل الفروع. الرجاء تسجيل الدخول مجدداً." };
  }
}

function getBranchIdByName_(branchName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const refBranches = getReferenceBranches_(ss);
    if (!refBranches.sheetExists) {
      return { success: false, message: "جدول الفروع غير موجود." };
    }

    const targetValue = String(branchName || "").trim();
    const targetName = targetValue.toLowerCase();
    if (!targetValue) {
      return { success: false, message: "اسم الفرع غير صالح." };
    }

    const branch = refBranches.byId[targetValue] || refBranches.byName[targetName];
    if (branch) {
      if (branch.status !== "active") {
        return { success: false, message: "الفرع غير نشط حالياً." };
      }
      return { success: true, branchId: branch.id };
    }
    return { success: false, message: "تعذر مطابقة اسم الفرع مع البيانات." };
  } catch (e) {
    console.error("getBranchIdByName_ failed", { message: e && e.message ? e.message : String(e) });
    return { success: false, message: "تعذر مطابقة الفرع حالياً. الرجاء المحاولة لاحقاً." };
  }
}

function getEmployeeBranchId_(ss, employeeNumber) {
  const user = getUserByEmployeeNumber_(ss, employeeNumber);
  return user ? user.branchId : "";
}

function getNormalizedQty_(itemId, quantity, selectedUnit) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const refUnits = getReferenceItemUnits_(ss);
    const itemIdStr = String(itemId).trim();
    const selectedUnitStr = String(selectedUnit).trim();
    const qty = parseNumericInput_(quantity);
    let conversionRate = 1; // المعدل الافتراضي إذا لم تُطابق وحدة

    const itemUnits = (refUnits.byItem || {})[itemIdStr] || [];
    for (let i = 0; i < itemUnits.length; i++) {
      const rowUnit = String(itemUnits[i].unitName || "").trim();
      if (rowUnit === selectedUnitStr) {
        const parsedRate = parseNumericInput_(itemUnits[i].conversionRate);
        conversionRate = isNaN(parsedRate) ? 1 : parsedRate;
        break;
      }
    }

    // حساب الكمية المعيارية الخفية
    return (isNaN(qty) ? 0 : qty) * conversionRate;
  } catch (e) {
    // في حال أي خطأ تشغيلي، العودة للقيمة الأصلية (معدل افتراضي = 1)
    const fallbackQty = parseNumericInput_(quantity);
    return isNaN(fallbackQty) ? 0 : fallbackQty;
  }
}

function calculateNormalizedQuantity_(itemId, quantity, selectedUnit) {
  return getNormalizedQty_(itemId, quantity, selectedUnit);
}

function getPublicUser_(user) {
  return {
    employeeNumber: user.employeeNumber,
    name: user.name,
    role: user.role,
    branch: user.branch,
    branchId: user.branchId
  };
}

function bootstrapUserApp(sessionToken) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, []);
    ensureRuntimeSchemaReady_();
    const itemsRes = getActiveItemsAndUnitsForUser_(ss, user);
    const data = {
      catalog: itemsRes.success ? itemsRes.catalog : {},
      itemOrder: itemsRes.success ? (itemsRes.itemOrder || []) : [],
      catalogMessage: itemsRes.success ? "" : itemsRes.message
    };

    if (user.role === "distributor") {
      const branchesRes = getActiveBranchesForUser_(ss, user);
      data.branches = branchesRes.success ? branchesRes.branches : [];
      data.branchesMessage = branchesRes.success ? "" : branchesRes.message;
    } else if (user.role === "manager") {
      const suppliersRes = getActiveSuppliersForUser_(ss, user);
      const allowedRes = getAllowedLocalPurchaseItemsForUser_(ss, user);
      data.suppliers = suppliersRes.success ? suppliersRes.suppliers : [];
      data.suppliersMessage = suppliersRes.success ? "" : suppliersRes.message;
      data.allowedLocalPurchaseItems = allowedRes.success ? allowedRes.items : [];
      data.allowedLocalPurchaseItemsMessage = allowedRes.success ? "" : allowedRes.message;
    }

    return {
      success: true,
      user: getPublicUser_(user),
      data: data
    };
  } catch (e) {
    console.error("bootstrapUserApp failed", e);
    return { success: false, message: "تعذر تحميل البيانات حالياً. يرجى المحاولة مرة أخرى." };
  }
}

function applyInventorySheetFormatting(sessionToken) {
  try {
    const adminContext = requireOwnerForAdmin_(sessionToken);
    const schemaStatus = validateInventorySchema_();
    if (!schemaStatus.success) {
      return {
        success: false,
        message: "تم إيقاف تنسيق الجداول لأن بنية الجداول تحتوي على مشاكل.",
        issues: schemaStatus.issues || [],
        schema: schemaStatus
      };
    }

    const ss = adminContext.ss;
    const formattedSheets = [];
    const issues = [];

    const textColumnsBySheet = {
      Users: ["employee_number", "pin", "status"],
      branches: ["status"],
      Suppliers: ["status"],
      Supplier_Items: ["status"],
      Transfers: ["status"]
    };
    const statusValidationBySheet = {
      Users: ["active", "inactive", "blocked"],
      branches: ["active", "inactive"],
      Suppliers: ["active", "inactive"],
      Supplier_Items: ["active", "inactive"],
      Transfers: ["pending", "approved", "missing"]
    };

    Object.keys(getInventorySchemaRequirements_()).forEach(function(sheetName) {
      const sheet = getSheetByNameCaseInsensitive_(ss, sheetName);
      if (!sheet) {
        issues.push("جدول " + sheetName + " غير موجود.");
        return;
      }

      const headerMap = getHeaderMap_(sheet);
      const maxRows = sheet.getMaxRows();
      sheet.setFrozenRows(1);
      if (typeof sheet.setRightToLeft === "function") {
        sheet.setRightToLeft(true);
      }

      (textColumnsBySheet[sheetName] || []).forEach(function(headerName) {
        const column = getHeaderIndex_(headerMap, headerName);
        if (column > 0 && maxRows > 1) {
          sheet.getRange(2, column, maxRows - 1, 1).setNumberFormat("@");
        }
      });

      const statusValues = statusValidationBySheet[sheetName];
      const statusColumn = getHeaderIndex_(headerMap, "status");
      if (statusValues && statusColumn > 0 && maxRows > 1) {
        const rule = SpreadsheetApp.newDataValidation()
          .requireValueInList(statusValues, true)
          .setAllowInvalid(false)
          .build();
        sheet.getRange(2, statusColumn, maxRows - 1, 1).setDataValidation(rule);
      }

      formattedSheets.push(sheetName);
    });

    return {
      success: issues.length === 0,
      message: issues.length === 0 ? "تم تطبيق تنسيق الجداول بنجاح." : "تم تطبيق التنسيق مع وجود تنبيهات.",
      sheets: formattedSheets,
      issues: issues
    };
  } catch (e) {
    console.error("applyInventorySheetFormatting failed", e);
    return { success: false, message: "تعذر تطبيق تنسيق الجداول حالياً.", issues: ["تعذر تطبيق تنسيق الجداول حالياً."] };
  }
}

function verifyEmployeeStatus(sessionToken) {
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  try {
    lock.waitLock(10000);
    lockAcquired = true;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss, sessionToken, []);
    return {
      success: true,
      status: "active",
      user: {
        employeeNumber: user.employeeNumber,
        name: user.name,
        role: user.role,
        branch: user.branch,
        branchId: user.branchId
      }
    };
  } catch (e) {
    console.error("verifyEmployeeStatus failed", e);
    return { success: false, message: "تعذر التحقق من حالة الموظف حالياً. الرجاء المحاولة لاحقاً." };
  } finally {
    if (lockAcquired) {
      lock.releaseLock();
    }
  }
}

// R01: the journal is durable; cache tokens only authorize the first attempt.
const INVENTORY_SUBMISSION_HEADERS = ['submission_id', 'employee_number', 'role', 'branch_id', 'kind', 'payload_hash', 'expected_json', 'expected_hash', 'state', 'created_at'];
const INVENTORY_SUBMISSION_GATE = 'inventory_submission_active_v1';
const INVENTORY_SUBMISSION_READY = 'inventory_submission_ready_v1';

function inventorySubmissionHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function inventorySubmissionJson_(value) {
  if (Array.isArray(value)) return '[' + value.map(inventorySubmissionJson_).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function(k) {
    return JSON.stringify(k) + ':' + inventorySubmissionJson_(value[k]);
  }).join(',') + '}';
  if (typeof value === 'number' && !isFinite(value)) throw new Error('Invalid quantity');
  return JSON.stringify(value === undefined ? null : value);
}

function requireInventorySubmissionId_(id) {
  if (!/^inv-[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('R01_REFRESH_REQUIRED');
  return String(id);
}

function inventorySubmissionGate_() {
  const raw = PropertiesService.getScriptProperties().getProperty(INVENTORY_SUBMISSION_GATE);
  return raw ? JSON.parse(raw) : null;
}

function setInventorySubmissionGate_(gate) {
  const props = PropertiesService.getScriptProperties();
  const value = JSON.stringify(gate);
  props.setProperty(INVENTORY_SUBMISSION_GATE, value);
  if (props.getProperty(INVENTORY_SUBMISSION_GATE) !== value) throw new Error('Submission gate verification failed');
}

function inventorySubmissionSheet_(ss) {
  if (PropertiesService.getScriptProperties().getProperty(INVENTORY_SUBMISSION_READY) !== '1') throw new Error('R01_SETUP_REQUIRED');
  const sheet = getSheetByNameCaseInsensitive_(ss, 'Inventory_Submissions');
  if (!sheet) throw new Error('R01_SETUP_REQUIRED');
  return {sheet:sheet, map:requireHeaderColumns_(sheet, INVENTORY_SUBMISSION_HEADERS)};
}

function setupInventoryReliability(sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  requireOwner_(ss, sessionToken);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    requireOwner_(ss, sessionToken);
    let sheet = getSheetByNameCaseInsensitive_(ss, 'Inventory_Submissions');
    if (!sheet) sheet = ss.insertSheet('Inventory_Submissions');
    const map = getHeaderMap_(sheet);
    const missing = INVENTORY_SUBMISSION_HEADERS.filter(function(h) { return !getHeaderIndex_(map, h); });
    if (missing.length) sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    requireHeaderColumns_(sheet, INVENTORY_SUBMISSION_HEADERS);
    sheet.setFrozenRows(1);
    const protections = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    const protection = protections.length ? protections[0] : sheet.protect();
    protection.setDescription('Inventory submission recovery journal').setWarningOnly(false);
    const effectiveEmail = Session.getEffectiveUser().getEmail();
    const editors = protection.getEditors().filter(function(u) { return u.getEmail() !== effectiveEmail; });
    if (editors.length) protection.removeEditors(editors);
    if (protection.canDomainEdit()) protection.setDomainEdit(false);
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty(INVENTORY_SUBMISSION_READY, '1');
    return {success:true, message:'تم تجهيز سجل حفظ العمليات دون تغيير الحركات السابقة.'};
  } finally { lock.releaseLock(); }
}

function readInventorySubmission_(ss, user, kind, id, payload) {
  requireInventorySubmissionId_(id);
  const journal = inventorySubmissionSheet_(ss);
  const data = journal.sheet.getLastRow() > 1 ? journal.sheet.getRange(2, 1, journal.sheet.getLastRow()-1, journal.map.__lastColumn).getValues() : [];
  const matches = [];
  data.forEach(function(row, i) { if (getCellByHeader_(row, journal.map, 'submission_id') === id) matches.push({row:row, number:i+2}); });
  if (matches.length > 1) throw new Error('Duplicate journal identity');
  if (!matches.length) return null;
  const match = matches[0], record = {};
  INVENTORY_SUBMISSION_HEADERS.forEach(function(h) { record[h] = getCellByHeader_(match.row, journal.map, h); });
  record.rowNumber = match.number;
  if (user.role !== 'owner' && (String(record.employee_number) !== String(user.employeeNumber) || record.role !== user.role || String(record.branch_id) !== String(user.branchId || ''))) throw new Error('Submission access denied');
  if (kind && record.kind !== kind) throw new Error('Submission kind mismatch');
  if (payload !== undefined && record.payload_hash !== inventorySubmissionHash_(inventorySubmissionJson_(payload))) throw new Error('Submission payload mismatch');
  if (record.state !== 'CANCELLED' && record.expected_json && inventorySubmissionHash_(String(record.expected_json)) !== record.expected_hash) throw new Error('Submission evidence mismatch');
  record.expected = record.state !== 'CANCELLED' && record.expected_json ? JSON.parse(record.expected_json) : null;
  return record;
}

function inventorySubmissionResult_(outcome, id, message) {
  return {success:outcome === 'COMMITTED', committed:outcome === 'COMMITTED', outcome:outcome, submissionId:id,
    retrySafe:outcome === 'NOT_SAVED', cancelled:outcome === 'CANCELLED', message:message || (outcome === 'UNKNOWN'
      ? 'نتيجة الحفظ غير مؤكدة. احتفظ بالطلب ورقم المتابعة وتواصل مع المالك للتحقق أو الاستعادة.'
      : outcome === 'NOT_SAVED' ? 'لم يُحفظ الطلب. يمكنك إعادة إرسال نفس الطلب أو إلغاءه قبل تعديله.' : '')};
}

function inventorySubmissionFailure_(error, id) {
  let outcome = 'UNKNOWN';
  let message = getSafeWriteErrorMessage_(error);
  if (error && error.message === 'R01_REFRESH_REQUIRED') { outcome = 'NOT_SAVED'; message = 'هذه الصفحة تحتاج إلى تحديث. لم يُحفظ الطلب منها. حدّث الصفحة وسجّل الدخول قبل الإرسال.'; }
  if (error && error.message === 'R01_BATCH_TOO_LARGE') message = 'الطلب كبير. اضغط تحقق من النتيجة أولًا. إذا تأكد أنه لم يُحفظ، ألغِه ثم أرسله على دفعات أصغر.';
  if (error && error.message === 'R01_SETUP_REQUIRED') message = 'الإرسال غير متاح حاليًا. احتفظ بالطلب وتواصل مع الإدارة قبل المحاولة مجددًا.';
  return inventorySubmissionResult_(outcome, id, message);
}

function assertSubmissionBalancesReady_(ss) {
  if (inventorySubmissionGate_()) throw new Error('توجد عملية قيد التحقق. لا تتوفر حركات أو أرصدة موثوقة حتى يكمل المالك مراجعتها.');
  // Fail closed if the setup marker or journal is lost after activation.
  if (PropertiesService.getScriptProperties().getProperty(INVENTORY_SUBMISSION_READY) === '1' || getSheetByNameCaseInsensitive_(ss, 'Inventory_Submissions')) {
    const j = inventorySubmissionSheet_(ss);
    if (j.sheet.getLastRow() > 1) {
      const states = j.sheet.getRange(2, getHeaderIndex_(j.map, 'state'), j.sheet.getLastRow()-1, 1).getValues();
      if (states.some(function(r) { return r[0] !== 'COMMITTED' && r[0] !== 'CANCELLED'; })) throw new Error('توجد عملية قيد التحقق. راجع سجل استعادة العمليات.');
    }
  }
}

function verifyInventorySubmissionRows_(ss, record, allowReceiptChanges) {
  const expected = record.expected;
  if (!expected || !expected.rows.length) return false;
  const sheet = getSheetByNameCaseInsensitive_(ss, expected.sheet);
  const map = requireHeaderColumns_(sheet, expected.headers);
  const data = sheet.getRange(expected.startRow, 1, expected.rows.length, map.__lastColumn).getValues();
  const formulas = sheet.getRange(expected.startRow, 1, expected.rows.length, map.__lastColumn).getFormulas();
  const mutableReceiptFields = ['status','missing_qty','note','received_quantity','received_unit','received_normalized_quantity','received_at','received_by'];
  for (let i = 0; i < expected.rows.length; i++) {
    for (let k = 0; k < expected.headers.length; k++) {
      const h = expected.headers[k], col = getHeaderIndex_(map,h)-1;
      if (allowReceiptChanges && expected.sheet === 'Transfers' && mutableReceiptFields.indexOf(h) !== -1) continue;
      if (formulas[i][col]) return false;
      const actual = data[i][col], value = expected.rows[i][k];
      if (h === 'created_at') {
        if (!(actual instanceof Date) || actual.getTime() !== Number(value)) return false;
      } else if (typeof value === 'number') {
        if (actual === '' || actual === null || !isFinite(Number(actual)) || Number(actual) !== value) return false;
      } else if (String(actual) !== String(value)) return false;
    }
  }
  const idHeader = expected.sheet === 'Purchases' ? 'purchase_id' : 'transfer_id';
  const ids = sheet.getLastRow() > 1 ? sheet.getRange(2, getHeaderIndex_(map,idHeader), sheet.getLastRow()-1, 1).getValues() : [];
  return ids.filter(function(r) { return r[0] === expected.transactionId; }).length === expected.rows.length;
}

function reconcileInventorySubmission_(ss, record) {
  if (record.state === 'CANCELLED') return inventorySubmissionResult_('CANCELLED', record.submission_id);
  if (!verifyInventorySubmissionRows_(ss, record, record.state === 'COMMITTED')) return inventorySubmissionResult_('UNKNOWN',record.submission_id);
  if (record.state !== 'COMMITTED') {
    const gate = inventorySubmissionGate_();
    if (!gate || gate.id !== record.submission_id) return inventorySubmissionResult_('UNKNOWN',record.submission_id);
    const j = inventorySubmissionSheet_(ss), column = getHeaderIndex_(j.map,'state');
    j.sheet.getRange(record.rowNumber,column).setValue('COMMITTED');
    SpreadsheetApp.flush();
    if (j.sheet.getRange(record.rowNumber,column).getValues()[0][0] !== 'COMMITTED') return inventorySubmissionResult_('UNKNOWN',record.submission_id);
  }
  const gate = inventorySubmissionGate_();
  if (gate && gate.id === record.submission_id) {
    // Invalidate readers at both ends of the write, including recovery.
    bumpBalanceSourceVersion_();
    PropertiesService.getScriptProperties().deleteProperty(INVENTORY_SUBMISSION_GATE);
    if (inventorySubmissionGate_()) return inventorySubmissionResult_('UNKNOWN',record.submission_id);
  }
  const result = inventorySubmissionResult_('COMMITTED',record.submission_id);
  result.transactionId = record.expected.transactionId;
  result[record.kind === 'purchase' ? 'purchaseId' : 'transferId'] = result.transactionId;
  result.itemCount = record.expected.rows.length;
  return result;
}

function saveInventorySubmission_(ss, user, kind, id, payload, sheet, headers, rows) {
  const existing = readInventorySubmission_(ss,user,kind,id,payload);
  if (existing) return reconcileInventorySubmission_(ss,existing);
  assertSubmissionBalancesReady_(ss);
  const j = inventorySubmissionSheet_(ss), map = requireHeaderColumns_(sheet, headers);
  const expected = {sheet:sheet.getName(), headers:headers, startRow:sheet.getLastRow()+1,
    transactionId:getCellByHeader_(rows[0],map,kind === 'purchase'?'purchase_id':'transfer_id'),
    rows:rows.map(function(row) { return headers.map(function(h) { const v=getCellByHeader_(row,map,h); return v instanceof Date ? v.getTime() : v; }); })};
  if (rows.some(function(row) { return row.some(function(v) { return typeof v === 'string' && /^=/.test(v); }); })) throw new Error('Invalid formula-like value');
  const json = JSON.stringify(expected);
  if (json.length > 40000) throw new Error('R01_BATCH_TOO_LARGE');
  const gate = {id:id, stage:'JOURNAL', employee_number:String(user.employeeNumber),role:user.role,branch_id:String(user.branchId || ''),kind:kind,
    payload_hash:inventorySubmissionHash_(inventorySubmissionJson_(payload)), journalRow:j.sheet.getLastRow()+1};
  setInventorySubmissionGate_(gate);
  const record = {submission_id:id,employee_number:gate.employee_number,role:gate.role,branch_id:gate.branch_id,kind:kind,
    payload_hash:gate.payload_hash,expected_json:json,expected_hash:inventorySubmissionHash_(json),state:'PREPARED',created_at:new Date()};
  j.sheet.getRange(gate.journalRow,1,1,j.map.__lastColumn).setValues([buildRowByHeaders_(j.map,record)]);
  SpreadsheetApp.flush();
  const persisted = readInventorySubmission_(ss,user,kind,id,payload);
  if (!persisted || persisted.expected_json !== json || persisted.state !== 'PREPARED') throw new Error('Journal readback failed');
  gate.stage = 'BUSINESS'; setInventorySubmissionGate_(gate);
  bumpBalanceSourceVersion_();
  try {
    sheet.getRange(expected.startRow,1,rows.length,map.__lastColumn).setValues(rows);
    SpreadsheetApp.flush();
  } catch (e) { /* The write may have persisted: reconcile, never append again. */ }
  return reconcileInventorySubmission_(ss,persisted);
}

function getInventorySubmissionStatus(submissionId, sessionToken) {
  const lock = LockService.getScriptLock(); let acquired = false;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const user = getAuthorizedUser_(ss,sessionToken,['manager','distributor','owner']);
    lock.waitLock(10000); acquired = true;
    const current = getAuthorizedUser_(ss,sessionToken,['manager','distributor','owner']);
    if (inventorySubmissionJson_([user.employeeNumber,user.role,user.branchId]) !== inventorySubmissionJson_([current.employeeNumber,current.role,current.branchId])) throw new Error('Session changed');
    const record = readInventorySubmission_(ss,current,null,submissionId);
    if (record) return reconcileInventorySubmission_(ss,record);
    if (inventorySubmissionGate_()) return inventorySubmissionResult_('UNKNOWN',submissionId);
    return inventorySubmissionResult_('NOT_SAVED',submissionId);
  } catch (e) { return inventorySubmissionFailure_(e,submissionId); }
  finally { if (acquired) lock.releaseLock(); }
}

function cancelInventorySubmission(submissionId, kind, payload, sessionToken) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  getAuthorizedUser_(ss,sessionToken,['manager','distributor']);
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const user = getAuthorizedUser_(ss,sessionToken,['manager','distributor']);
    if (['purchase','transfer'].indexOf(kind) === -1) throw new Error('Invalid kind');
    const record = readInventorySubmission_(ss,user,kind,submissionId,payload);
    if (record) return record.state === 'CANCELLED' ? inventorySubmissionResult_('CANCELLED',submissionId) : inventorySubmissionResult_('UNKNOWN',submissionId);
    assertSubmissionBalancesReady_(ss);
    const j=inventorySubmissionSheet_(ss);
    const row={submission_id:submissionId,employee_number:String(user.employeeNumber),role:user.role,branch_id:String(user.branchId || ''),kind:kind,
      payload_hash:inventorySubmissionHash_(inventorySubmissionJson_(payload)),expected_json:'',expected_hash:'',state:'CANCELLED',created_at:new Date()};
    j.sheet.getRange(j.sheet.getLastRow()+1,1,1,j.map.__lastColumn).setValues([buildRowByHeaders_(j.map,row)]);
    SpreadsheetApp.flush();
    const saved=readInventorySubmission_(ss,user,kind,submissionId,payload);
    return inventorySubmissionResult_(saved && saved.state === 'CANCELLED' ? 'CANCELLED':'UNKNOWN',submissionId);
  } finally {lock.releaseLock();}
}

function getOwnerInventorySubmissions(sessionToken) {
  const ss=SpreadsheetApp.getActiveSpreadsheet(),user=requireOwner_(ss,sessionToken),j=inventorySubmissionSheet_(ss);
  const rows=j.sheet.getLastRow()>1?j.sheet.getRange(2,1,j.sheet.getLastRow()-1,j.map.__lastColumn).getValues():[];
  const entries=rows.filter(function(r){return getCellByHeader_(r,j.map,'state') === 'PREPARED';}).map(function(r){
    const id=getCellByHeader_(r,j.map,'submission_id');
    let record;
    try { record=readInventorySubmission_(ss,user,null,id); } catch(e) { return {id:id,state:'CONFLICT',employee:'',branch:'',kind:''}; }
    return {id:id,employee:record.employee_number,branch:record.branch_id,kind:record.kind,state:record.state,expected:record.expected};
  });
  const gate=inventorySubmissionGate_();
  if(gate && !entries.some(function(e){return e.id===gate.id;})) entries.push({id:gate.id,employee:gate.employee_number,branch:gate.branch_id,kind:gate.kind,state:gate.stage});
  return {success:true,submissions:entries};
}

function ownerRecoverInventorySubmission(submissionId, sessionToken) {
  const ss=SpreadsheetApp.getActiveSpreadsheet();requireOwner_(ss,sessionToken);
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    const owner=requireOwner_(ss,sessionToken),gate=inventorySubmissionGate_();
    let record = null;
    try { record=readInventorySubmission_(ss,owner,null,submissionId); }
    catch (error) { if (!gate || gate.id !== submissionId || gate.stage !== 'JOURNAL') throw error; }
    if (!gate || gate.id !== submissionId) return record ? reconcileInventorySubmission_(ss,record) : inventorySubmissionResult_('UNKNOWN',submissionId);
    tryLogCommittedAction_('OWNER_RECOVER_SUBMISSION', 'Owner inspected submission recovery', {entityId:submissionId, employeeNumber:owner.employeeNumber}, getSheetByNameCaseInsensitive_(ss,'Logs'), new Date());
    if ((!record || !record.expected) && gate.stage === 'JOURNAL') {
      const j=inventorySubmissionSheet_(ss);
      const slot=j.sheet.getRange(gate.journalRow,1,1,j.map.__lastColumn).getValues()[0];
      const binding={submission_id:submissionId,employee_number:gate.employee_number,role:gate.role,branch_id:gate.branch_id,kind:gate.kind,payload_hash:gate.payload_hash};
      Object.keys(binding).forEach(function(h) {
        const value=getCellByHeader_(slot,j.map,h);
        if(value!=='' && String(value)!==String(binding[h])) throw new Error('Journal slot conflict; preserve evidence');
      });
      if(getCellByHeader_(slot,j.map,'state')==='COMMITTED') throw new Error('Conflicting committed journal');
      Object.keys(binding).forEach(function(h) {
        if(getCellByHeader_(slot,j.map,h)==='') j.sheet.getRange(gate.journalRow,getHeaderIndex_(j.map,h)).setValue(binding[h]);
      });
      j.sheet.getRange(gate.journalRow,getHeaderIndex_(j.map,'state')).setValue('CANCELLED');
      SpreadsheetApp.flush();record=readInventorySubmission_(ss,owner,null,submissionId);
      if(!record || record.state!=='CANCELLED') return inventorySubmissionResult_('UNKNOWN',submissionId);
      PropertiesService.getScriptProperties().deleteProperty(INVENTORY_SUBMISSION_GATE);
      if(inventorySubmissionGate_()) return inventorySubmissionResult_('UNKNOWN',submissionId);
      return inventorySubmissionResult_('CANCELLED',submissionId);
    }
    if (!record || !record.expected) return inventorySubmissionResult_('UNKNOWN',submissionId);
    const result=reconcileInventorySubmission_(ss,record);if(result.committed) return result;
    const expected=record.expected,sheet=getSheetByNameCaseInsensitive_(ss,expected.sheet),map=requireHeaderColumns_(sheet,expected.headers);
    const actual=sheet.getRange(expected.startRow,1,expected.rows.length,map.__lastColumn).getValues();
    const formulas=sheet.getRange(expected.startRow,1,expected.rows.length,map.__lastColumn).getFormulas();
    const patches=[];
    expected.rows.forEach(function(row,i){row.forEach(function(value,k){
      const h=expected.headers[k],col=getHeaderIndex_(map,h)-1,v=actual[i][col];
      const equal=h==='created_at' ? v instanceof Date && v.getTime()===value : typeof value==='number' ? v!=='' && Number(v)===value : String(v)===String(value);
      if(formulas[i][col] || (!equal && v!=='')) throw new Error('Conflicting saved cell; preserve evidence and escalate');
      if(!equal) patches.push({row:expected.startRow+i,column:col+1,value:h==='created_at'?new Date(value):value});
    });});
    // A moved/duplicated transaction must never be repaired at its former row.
    const idCol=getHeaderIndex_(map,record.kind==='purchase'?'purchase_id':'transfer_id');
    const ids=sheet.getLastRow()>1?sheet.getRange(2,idCol,sheet.getLastRow()-1,1).getValues():[];
    ids.forEach(function(r,i){if(r[0]===expected.transactionId && (i+2<expected.startRow || i+2>=expected.startRow+expected.rows.length)) throw new Error('Transaction moved or duplicated');});
    gate.stage='BUSINESS';setInventorySubmissionGate_(gate);bumpBalanceSourceVersion_();
    patches.forEach(function(p){sheet.getRange(p.row,p.column).setValue(p.value);});
    SpreadsheetApp.flush();
    return reconcileInventorySubmission_(ss,record);
  } finally {lock.releaseLock();}
}

// A read that overlaps a write cannot publish a mixed snapshot.
function withInventorySubmissionRead_(ss, read) {
  assertSubmissionBalancesReady_(ss);
  const before=getBalanceSourceVersion_();
  if(before===null) throw new Error('Movement version unavailable');
  const result=read();
  assertSubmissionBalancesReady_(ss);
  if(getBalanceSourceVersion_()!==before) throw new Error('تغيرت الحركات أثناء القراءة. حدّث الشاشة للتحقق.');
  return result;
}

function getOwnerPurchases(branchId, dateFrom, dateTo, sessionToken) {
  return withInventorySubmissionRead_(SpreadsheetApp.getActiveSpreadsheet(), function() { return getOwnerPurchasesR01Read_(branchId, dateFrom, dateTo, sessionToken); });
}

function getOwnerTransfers(branchId, dateFrom, dateTo, sessionToken) {
  return withInventorySubmissionRead_(SpreadsheetApp.getActiveSpreadsheet(), function() { return getOwnerTransfersR01Read_(branchId, dateFrom, dateTo, sessionToken); });
}

function getSentTransfersLogForUser_(ss, user) {
  return withInventorySubmissionRead_(ss, function() { return getSentTransfersLogForUserR01Read_(ss, user); });
}

function getBranchPendingTransfersForUser_(ss, user) {
  return withInventorySubmissionRead_(ss, function() { return getBranchPendingTransfersForUserR01Read_(ss, user); });
}

function getTodayManagerPurchases(sessionToken) {
  return withInventorySubmissionRead_(SpreadsheetApp.getActiveSpreadsheet(), function() { return getTodayManagerPurchasesR01Read_(sessionToken); });
}

function getInventoryBalances(sessionToken) {
  return withInventorySubmissionRead_(SpreadsheetApp.getActiveSpreadsheet(), function() { return getInventoryBalancesR01Read_(sessionToken); });
}

function getSavedInventoryBalancesForBranch_(ss, branchId) {
  return withInventorySubmissionRead_(ss, function() { return getSavedInventoryBalancesForBranchR01Read_(ss, branchId); });
}

function buildBalanceSnapshotRowsForPeriod_(ss, options) {
  return withInventorySubmissionRead_(ss, function() { return buildBalanceSnapshotRowsForPeriodR01Read_(ss, options); });
}

function buildExpectedMovementSummaryMap_(ss, now) {
  return withInventorySubmissionRead_(ss, function() { return buildExpectedMovementSummaryMapR01Read_(ss, now); });
}

function collectPendingTransferSourceRows_(transfersSheet, transfersHeaderMap, branchId) {
  return withInventorySubmissionRead_(SpreadsheetApp.getActiveSpreadsheet(), function() { return collectPendingTransferSourceRowsR01Read_(transfersSheet, transfersHeaderMap, branchId); });
}

function collectArchivePurchasesCandidates_(ss, cutoffDate, dryRunBySheet) {
  return withInventorySubmissionRead_(ss, function() { return collectArchivePurchasesCandidatesR01Read_(ss, cutoffDate, dryRunBySheet); });
}

function collectArchiveTransfersCandidates_(ss, cutoffDate, dryRunBySheet) {
  return withInventorySubmissionRead_(ss, function() { return collectArchiveTransfersCandidatesR01Read_(ss, cutoffDate, dryRunBySheet); });
}

// R02 FORMULA BALANCES BEGIN
// Only these two derived tables are rebuilt; business history and R01 journals are never edited.
const FORMULA_BALANCE_SOURCE = 'Inventory_Balance_Formula_Source';
const FORMULA_BALANCE_OUTPUT = 'Inventory_Balance_Formulas';
const FORMULA_BALANCE_ENABLED = 'inventory_formula_balance_v1_enabled';
const FORMULA_BALANCE_READY = 'inventory_formula_balance_v1_ready';
const FORMULA_BALANCE_RUNTIME_BUDGET_MS = 240000;
const FORMULA_BALANCE_SOURCE_HEADERS = ['source_kind','source_row','item_id','purchase_branch','source_branch','target_branch','created_epoch','receipt_epoch','normalized_quantity','received_normalized_quantity','has_received','missing_quantity','status','effective_received'];
const FORMULA_BALANCE_HEADERS = ['branch_id','item_id','period_month','movement_start_epoch','period_end_epoch','starting_balance','purchases_since_start','received_since_start','sent_since_start','total_in','balance','calculated_at','run_id','warning','input_signature','monthly_purchases','monthly_received','monthly_sent','monthly_net_movement','period_start_epoch'];

function getFormulaBalanceEpoch_(value) {
  const date = parseSheetDate_(value);
  return date ? date.getTime() : -8640000000000001;
}

function formulaBalanceDigest_(value) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8));
}

function formulaBalanceNumber_(value) {
  if (typeof value !== 'number' || !isFinite(value)) throw new Error('formula_balance_not_ready');
  return value;
}

function checkFormulaBalanceRuntime_(startedAtMs,stage,sourceRows,outputRows) {
  console.log('Formula balance phase',stage,Date.now()-startedAtMs,sourceRows || 0,outputRows || 0);
  assertBalanceRuntimeBudget_(startedAtMs,stage,FORMULA_BALANCE_RUNTIME_BUDGET_MS);
}

function readFormulaBalanceInputs_(ss,periodMonth) {
  inventorySubmissionSheet_(ss);
  assertSubmissionBalancesReady_(ss);
  const version = getBalanceSourceVersion_();
  if (version === null) throw new Error('Movement version unavailable');
  const selected=String(periodMonth || getCurrentInventoryPeriod_()).trim();
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected) || Number(selected.slice(0,4))<100 || selected>getCurrentInventoryPeriod_()) throw new Error('Invalid or future formula period');
  const period = getBalancePeriodBounds_(selected);
  const sources = {};
  ['Purchases','Transfers','Items','Item_Units','branches'].forEach(function(name) {
    const sheet = getSheetByNameCaseInsensitive_(ss,name);
    if (!sheet) throw new Error('Missing formula input: ' + name);
    sources[name] = {map:requireHeaderColumns_(sheet,getInventorySchemaRequirements_()[name]), rows:sheet.getDataRange().getValues()};
  });
  const counts = getLatestInventoryCountsBefore_(ss,null,null,period.periodStart);
  const baselines = getActiveBalanceBaselineMapForBranchPeriod_(ss,'',period.periodMonth);
  const available={};
  ['Inventory_Counts','Inventory_Count_Lines','Inventory_Balance_Baselines'].forEach(function(name) {
    const sheet=getSheetByNameCaseInsensitive_(ss,name); available[name]=!!sheet;
    if(sheet) requireHeaderColumns_(sheet,name==='Inventory_Balance_Baselines'?getBalanceBaselineHeaders_().slice(0,10):getInventorySchemaRequirements_()[name]);
  });
  const fullUsers = getUsersIndex_(ss), users = {byEmployeeNumber:{}};
  Object.keys(fullUsers.byEmployeeNumber).sort().forEach(function(id) {
    const user = fullUsers.byEmployeeNumber[id];
    users.byEmployeeNumber[id] = {role:user.role, branchId:user.branchId};
  });
  const signature = formulaBalanceDigest_({version:version,period:period.periodMonth,periodStart:period.periodStart.getTime(),periodEnd:period.periodEnd.getTime(),scriptTimezone:Session.getScriptTimeZone(),sheetTimezone:ss.getSpreadsheetTimeZone(),sources:sources,counts:counts,baselines:baselines,users:users,available:available});
  if (getBalanceSourceVersion_() !== version) throw new Error('Formula inputs changed');
  return {version:version,period:period,sources:sources,counts:counts,baselines:baselines,users:users,available:available,signature:signature};
}

function buildFormulaBalancePlan_(input) {
  const sources = input.sources, catalog = Object.create(null), branchItems = Object.create(null), incomplete = Object.create(null), feed = [];
  const cell = function(source,row,header) { return getCellByHeader_(row,source.map,header); };
  const inPeriod=function(epoch) { return epoch>=input.period.periodStart.getTime() && epoch<=input.period.periodEnd.getTime(); };
  function add(branch,item) {
    if (!branch || branch === 'DISTRIBUTOR' || !item) return;
    if (!branchItems[branch]) branchItems[branch] = Object.create(null);
    branchItems[branch][item] = true;
  }
  sources.Items.rows.slice(1).forEach(function(row) {
    const id = String(cell(sources.Items,row,'item_id') || '').trim();
    if (id) catalog[id] = {itemId:id,nameAr:String(cell(sources.Items,row,'name_ar') || '').trim(),baseUnit:String(cell(sources.Items,row,'base_unit') || '').trim(),sortOrder:parseSheetNumber_(cell(sources.Items,row,'sort_order'),999999999)};
  });
  sources.branches.rows.slice(1).forEach(function(row) {
    const branch = String(cell(sources.branches,row,'branch_id') || '').trim();
    Object.keys(catalog).forEach(function(id) { add(branch,id); });
  });
  Object.keys(input.counts).forEach(function(branch) { Object.keys(input.counts[branch]).forEach(function(id) { add(branch,id); }); });
  Object.keys(input.baselines.byBranch).forEach(function(branch) { Object.keys(input.baselines.byBranch[branch].items).forEach(function(id) { add(branch,id); }); });
  sources.Purchases.rows.slice(1).forEach(function(row,index) {
    const s=sources.Purchases, branch=String(cell(s,row,'branch') || '').trim(), id=String(cell(s,row,'item_id') || '').trim();
    const created=getFormulaBalanceEpoch_(cell(s,row,'created_at')), rawQty=parseFloat(cell(s,row,'normalized_quantity')), qty=isFinite(rawQty)?rawQty:0;
    if(created===-8640000000000001 || (inPeriod(created) && (!id || !isFinite(rawQty)))) incomplete[branch]=true;
    if(inPeriod(created) || created===-8640000000000001) add(branch,id);
    feed.push(['purchase',index+2,id,branch,'','',created,-8640000000000001,qty,0,0,0,'',0]);
  });
  sources.Transfers.rows.slice(1).forEach(function(row,index) {
    const s=sources.Transfers, id=String(cell(s,row,'item_id') || '').trim(), target=String(cell(s,row,'branch') || '').trim();
    const stored=String(cell(s,row,'source_branch') || '').trim();
    const durable=/^TRF-inv-[a-f0-9]{32}$/.test(String(cell(s,row,'transfer_id') || ''));
    const source=durable ? stored : resolveTransferSourceBranchForMigration_(input.users,cell(s,row,'created_by'),stored);
    const created=getFormulaBalanceEpoch_(cell(s,row,'created_at'));
    const receivedAt=parseSheetDate_(cell(s,row,'received_at')) || parseSheetDate_(cell(s,row,'created_at'));
    const received=getReceivedNormalizedQuantityForBalance_(row,s.map), status=String(cell(s,row,'status') || '').trim().toLowerCase();
    const rawQty=parseFloat(cell(s,row,'normalized_quantity'));
    if(created===-8640000000000001 || (inPeriod(created) && (!id || !isFinite(rawQty)))) incomplete[source]=true;
    if((status==='approved' || status==='missing') && (!receivedAt || (inPeriod(getFormulaBalanceEpoch_(receivedAt)) && (!id || (received===null && !isFinite(rawQty)))))) incomplete[target]=true;
    if(inPeriod(created) || created===-8640000000000001) add(source,id);
    if((status==='approved' || status==='missing') && (!receivedAt || inPeriod(getFormulaBalanceEpoch_(receivedAt)))) add(target,id);
    feed.push(['transfer',index+2,id,'',source,target,created,getFormulaBalanceEpoch_(receivedAt),isFinite(rawQty)?rawQty:0,received === null ? 0 : formulaBalanceNumber_(received),received === null ? 0 : 1,formulaBalanceNumber_(parseFloat(cell(s,row,'missing_qty')) || 0),status,0]);
  });
  if (!feed.length) feed.push(['',0,'','','','',-8640000000000001,-8640000000000001,0,0,0,0,'',0]);
  const keys = [];
  Object.keys(branchItems).sort().forEach(function(branch) {
    const items = Object.keys(branchItems[branch]).map(function(id) { return catalog[id] || {itemId:id,nameAr:id,baseUnit:'',sortOrder:999999999}; });
    sortItemsByCustomOrder_(items);
    items.forEach(function(item) {
      const baseline=input.baselines.byBranch[branch], count=(input.counts[branch] || {})[item.itemId];
      const hasBaseline=!!(baseline && Object.prototype.hasOwnProperty.call(baseline.items,item.itemId));
      const opening=hasBaseline ? baseline.items[item.itemId] : count ? count.normalizedQuantity : 0;
      const start=getBaselineEffectiveDateForBranchPeriod_(input.baselines,branch,input.period.periodStart).getTime();
      let warning=!hasBaseline && !count ? 'missing_start' : '';
      if(!item.baseUnit) { incomplete[branch]=true; warning += '|missing_unit'; }
      if(incomplete[branch]) warning += '|incomplete_inputs';
      if (feed.some(function(row) { return row[5]===branch && row[2]===item.itemId && row[12]==='missing' && row[10]===0 && row[7]>=start && row[7]<=input.period.periodEnd.getTime(); })) warning += '|legacy_receipt';
      keys.push({branch:branch,item:item,opening:formulaBalanceNumber_(opening),start:start,warning:warning});
    });
  });
  return {feed:feed,keys:keys,incomplete:incomplete};
}

function getFormulaBalanceExpressions_(row,lastSourceRow,startColumn) {
  const start=startColumn || 'D';
  const range=function(col) { return FORMULA_BALANCE_SOURCE+'!$'+col+'$2:$'+col+'$'+lastSourceRow; };
  function total(branch,date,quantity,kind) {
    return '=SUMPRODUCT(ARRAYFORMULA(N(EXACT('+range(branch)+',$A'+row+'))*N(EXACT('+range('C')+',$B'+row+'))*('+range('A')+'="'+kind+'")*('+range(date)+'>=$'+start+row+')*('+range(date)+'<=$E'+row+')*'+range(quantity)+'))';
  }
  return [total('D','G','I','purchase'),total('F','H','N','transfer'),total('E','G','I','transfer'),'=G'+row+'+H'+row,'=F'+row+'+J'+row+'-I'+row];
}

function getFormulaMonthlyChecks_(feed,start,end) {
  const checks=Object.create(null);
  function add(branch,item,column,quantity) {
    if(!branch || branch==='DISTRIBUTOR' || !item) return;
    const key=JSON.stringify([branch,item]);
    if(!checks[key]) checks[key]=[0,0,0];
    checks[key][column]+=quantity;
  }
  feed.forEach(function(row) {
    const created=row[6]>=start && row[6]<=end, received=row[7]>=start && row[7]<=end;
    if(row[0]==='purchase' && created) add(row[3],row[2],0,row[8]);
    if(row[0]!=='transfer') return;
    if(created) add(row[4],row[2],2,row[8]);
    if(received && (row[12]==='approved' || row[12]==='missing')) add(row[5],row[2],1,row[10]===1 ? row[9] : row[12]==='approved' ? row[8] : Math.max(0,row[8]-row[11]));
  });
  return checks;
}

function formulaBalanceWriteRows_(sheet,rows,formulaColumns,startedAtMs) {
  assertBalanceRuntimeBudget_(startedAtMs,'Formula table capacity',FORMULA_BALANCE_RUNTIME_BUDGET_MS);
  const oldRows=Math.max(0,sheet.getLastRow()-1), width=sheet.getLastColumn();
  if (rows.length+1>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),rows.length+1-sheet.getMaxRows());
  assertBalanceRuntimeBudget_(startedAtMs,'Formula table formatting',FORMULA_BALANCE_RUNTIME_BUDGET_MS);
  // Retained DATE formatting must not coerce the selected YYYY-MM into a date.
  if(rows.length && sheet.getName()===FORMULA_BALANCE_OUTPUT) sheet.getRange(2,3,rows.length,1).setNumberFormat('@');
  const safe=rows.map(function(row) { return row.map(function(value,col) {
    // Controlled literal formulas preserve formula-like IDs and leading apostrophes exactly.
    return typeof value==='string' && !formulaColumns[col] && /^[=+'@-]/.test(value) ? '="'+value.replace(/"/g,'""')+'"' : value;
  }); });
  assertBalanceRuntimeBudget_(startedAtMs,'Formula table values',FORMULA_BALANCE_RUNTIME_BUDGET_MS);
  if (safe.length) sheet.getRange(2,1,safe.length,width).setValues(safe);
  if (oldRows>rows.length) {
    assertBalanceRuntimeBudget_(startedAtMs,'Formula table shrink',FORMULA_BALANCE_RUNTIME_BUDGET_MS);
    sheet.getRange(rows.length+2,1,oldRows-rows.length,width).clearContent();
  }
}

function getFormulaBalanceTables_(ss) {
  const source=getSheetByNameCaseInsensitive_(ss,FORMULA_BALANCE_SOURCE), output=getSheetByNameCaseInsensitive_(ss,FORMULA_BALANCE_OUTPUT);
  if (!source || !output) throw new Error('Formula setup required');
  [[source,FORMULA_BALANCE_SOURCE_HEADERS],[output,FORMULA_BALANCE_HEADERS]].forEach(function(pair) {
    if (JSON.stringify(pair[0].getRange(1,1,1,pair[0].getLastColumn()).getValues()[0])!==JSON.stringify(pair[1])) throw new Error('Formula schema mismatch');
  });
  return {source:source,output:output};
}

function readFormulaBalanceTables_(tables) {
  const source=tables.source.getDataRange().getValues(), rows=tables.output.getDataRange().getValues();
  source.slice(1).forEach(function(row) { formulaBalanceNumber_(row[13]); });
  const seen=Object.create(null);
  rows.slice(1).forEach(function(row) {
    const key=JSON.stringify([row[0],row[1]]);
    if (!row[0] || !row[1] || seen[key]) throw new Error('Incomplete or duplicate formula result');
    seen[key]=true;
    for(let col=5;col<=10;col++) formulaBalanceNumber_(row[col]);
    for(let col=15;col<=18;col++) formulaBalanceNumber_(row[col]);
  });
  const sourceFormulas=tables.source.getDataRange().getFormulas(), outputFormulas=tables.output.getDataRange().getFormulas();
  return {source:source.slice(1),sourceFormulas:sourceFormulas.slice(1),rows:rows.slice(1),outputFormulas:outputFormulas.slice(1),digest:formulaBalanceDigest_([source,rows,sourceFormulas,outputFormulas])};
}

function refreshFormulaBalanceTables_(ss,input,startedAtMs) {
  const runtimeStartedAtMs=Number(startedAtMs) || Date.now();
  checkFormulaBalanceRuntime_(runtimeStartedAtMs,'refresh start');
  const previousRaw=PropertiesService.getScriptProperties().getProperty(FORMULA_BALANCE_READY);
  if(previousRaw) {
    const previous=JSON.parse(previousRaw);
    Object.keys(previous.available || {}).forEach(function(name) { if(previous.available[name] && !input.available[name]) throw new Error('Previously available opening source lost: '+name); });
  }
  const plan=buildFormulaBalancePlan_(input), now=new Date(), runId='FORM-'+Utilities.getUuid();
  checkFormulaBalanceRuntime_(runtimeStartedAtMs,'plan ready',plan.feed.length,plan.keys.length);
  const monthlyChecks=getFormulaMonthlyChecks_(plan.feed,input.period.periodStart.getTime(),input.period.periodEnd.getTime());
  // This existing calculation is a parity guard, never the values written to movement formula columns.
  const reference=buildBalanceSnapshotRowsForPeriod_(ss,{periodMonth:input.period.periodMonth,calculatedAt:now,startedAtMs:runtimeStartedAtMs,runtimeBudgetMs:FORMULA_BALANCE_RUNTIME_BUDGET_MS});
  const referenceMap=Object.create(null), referenceHeader=getHeaderMap_(getSheetByNameCaseInsensitive_(ss,'Inventory_Balances'));
  reference.rowsToAppend.forEach(function(row) {
    referenceMap[JSON.stringify([getCellByHeader_(row,referenceHeader,'branch_id'),getCellByHeader_(row,referenceHeader,'item_id')])]=['starting_balance','total_in','total_out','balance'].map(function(h){return getCellByHeader_(row,referenceHeader,h);});
  });
  checkFormulaBalanceRuntime_(runtimeStartedAtMs,'parity ready',plan.feed.length,plan.keys.length);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    assertSubmissionBalancesReady_(ss);
    if (getBalanceSourceVersion_()!==input.version) throw new Error('Formula inputs changed before publication');
    const tables=getFormulaBalanceTables_(ss), props=PropertiesService.getScriptProperties();
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'publication start',plan.feed.length,plan.keys.length);
    const preparing=JSON.stringify({version:1,state:'PREPARING',available:input.available});
    props.setProperty(FORMULA_BALANCE_READY,preparing);
    if(props.getProperty(FORMULA_BALANCE_READY)!==preparing) throw new Error('Formula preparation not retained');
    plan.feed.forEach(function(row,index) { const r=index+2; row[13]='=IF(OR(M'+r+'="approved",M'+r+'="missing"),IF(K'+r+'=1,J'+r+',IF(M'+r+'="approved",I'+r+',MAX(0,I'+r+'-L'+r+'))),0)'; });
    const output=plan.keys.map(function(key,index) {
      const r=index+2;
      return [key.branch,key.item.itemId,input.period.periodMonth,key.start,input.period.periodEnd.getTime(),key.opening].concat(getFormulaBalanceExpressions_(r,plan.feed.length+1),[now,runId,key.warning,input.signature],getFormulaBalanceExpressions_(r,plan.feed.length+1,'T').slice(0,3),['=P'+r+'+Q'+r+'-R'+r,input.period.periodStart.getTime()]);
    });
    formulaBalanceWriteRows_(tables.source,plan.feed,{13:true},runtimeStartedAtMs);
    formulaBalanceWriteRows_(tables.output,output,{6:true,7:true,8:true,9:true,10:true,15:true,16:true,17:true,18:true},runtimeStartedAtMs);
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'tables written',plan.feed.length,plan.keys.length);
    SpreadsheetApp.flush();
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'flush returned',plan.feed.length,plan.keys.length);
    const saved=readFormulaBalanceTables_(tables);
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'readback ready',plan.feed.length,plan.keys.length);
    if (saved.rows.length!==plan.keys.length || tables.source.getLastRow()!==plan.feed.length+1) throw new Error('Incomplete formula publication');
    saved.source.forEach(function(row,index) {
      if(JSON.stringify(row.slice(0,13))!==JSON.stringify(plan.feed[index].slice(0,13)) || saved.sourceFormulas[index][13]!==plan.feed[index][13]) throw new Error('Formula source readback mismatch');
    });
    saved.rows.forEach(function(row,index) {
      const key=plan.keys[index], expected=referenceMap[JSON.stringify([key.branch,key.item.itemId])] || [0,0,0,0];
      if(row[0]!==key.branch || row[1]!==key.item.itemId || row[14]!==input.signature) throw new Error('Formula identity mismatch');
      const formulaCols=[6,7,8,9,10,15,16,17,18], metadataCols=[0,1,2,3,4,5,11,12,13,14,19];
      if(JSON.stringify(formulaCols.map(function(col){return saved.outputFormulas[index][col];}))!==JSON.stringify(formulaCols.map(function(col){return output[index][col];}))) throw new Error('Formula expressions not retained');
      if(JSON.stringify(metadataCols.map(function(col){return row[col];}))!==JSON.stringify(metadataCols.map(function(col){return output[index][col];}))) throw new Error('Formula metadata readback mismatch');
      const month=monthlyChecks[JSON.stringify([key.branch,key.item.itemId])] || [0,0,0];
      const want=expected.concat(month,[month[0]+month[1]-month[2]]);
      [row[5],row[9],row[8],row[10],row[15],row[16],row[17],row[18]].forEach(function(value,i) {
        formulaBalanceNumber_(want[i]);
        if(Math.abs(value-want[i])>Number.EPSILON*8*Math.max(1,Math.abs(value),Math.abs(want[i]))) throw new Error('Formula differs from monthly rules');
      });
    });
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'validation ready',plan.feed.length,plan.keys.length);
    const after=readFormulaBalanceInputs_(ss,input.period.periodMonth);
    if(after.signature!==input.signature) throw new Error('Formula inputs changed during publication');
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'readiness publication',plan.feed.length,plan.keys.length);
    const ready={version:1,state:'READY',inputSignature:input.signature,digest:saved.digest,runId:runId,rowCount:saved.rows.length,calculatedAt:now.toISOString(),available:input.available};
    const json=JSON.stringify(ready); props.setProperty(FORMULA_BALANCE_READY,json);
    if(props.getProperty(FORMULA_BALANCE_READY)!==json) throw new Error('Formula readiness not retained');
    checkFormulaBalanceRuntime_(runtimeStartedAtMs,'ready retained',plan.feed.length,plan.keys.length);
    return {saved:saved,ready:ready,plan:plan};
  } finally { lock.releaseLock(); }
}

function getFormulaInventoryBalances_(ss,branchId,periodMonth) {
  const startedAtMs=Date.now();
  if(PropertiesService.getScriptProperties().getProperty(FORMULA_BALANCE_ENABLED)!=='1') return null;
  try {
    const input=readFormulaBalanceInputs_(ss,periodMonth);
    checkFormulaBalanceRuntime_(startedAtMs,'reader inputs ready');
    const plan=buildFormulaBalancePlan_(input);
    checkFormulaBalanceRuntime_(startedAtMs,'reader plan ready',plan.feed.length,plan.keys.length);
    if(plan.incomplete[String(branchId || '').trim()]) throw new Error('Incomplete formula input dates or quantities');
    const tables=getFormulaBalanceTables_(ss), raw=PropertiesService.getScriptProperties().getProperty(FORMULA_BALANCE_READY);
    let ready=null, saved=null;
    try { ready=raw ? JSON.parse(raw) : null; saved=readFormulaBalanceTables_(tables); } catch(readError) {}
    checkFormulaBalanceRuntime_(startedAtMs,'reader tables ready',plan.feed.length,plan.keys.length);
    if(!ready || ready.version!==1 || ready.state!=='READY' || ready.inputSignature!==input.signature || !saved || ready.digest!==saved.digest || ready.rowCount!==saved.rows.length) {
      const refreshed=refreshFormulaBalanceTables_(ss,input,startedAtMs); ready=refreshed.ready; saved=refreshed.saved;
    }
    const items=Object.create(null);
    plan.keys.forEach(function(key) { items[JSON.stringify([key.branch,key.item.itemId])]=key.item; });
    const rows=saved.rows.filter(function(row) { return row[0]===String(branchId || '').trim(); });
    const missingStart=rows.some(function(row){return String(row[13]).indexOf('missing_start')!==-1;}), legacyReceipt=rows.some(function(row){return String(row[13]).indexOf('legacy_receipt')!==-1;});
    const result={success:true,periodMonth:input.period.periodMonth,calculatedAt:formatBalanceSnapshotDateTime_(ready.calculatedAt),runId:ready.runId,warning:[missingStart?'missing_start':'',legacyReceipt?'legacy_receipt':''].filter(Boolean).join('|'),message:(missingStart?'بعض المواد تبدأ من صفر لعدم وجود جرد سابق. ':'')+(legacyReceipt?'توجد حركات قديمة استُخدمت لها بيانات الاستلام المتاحة.':''),balances:rows.map(function(row) {
      const item=items[JSON.stringify([row[0],row[1]])];
      if(!item) throw new Error('Formula catalog mismatch');
      return {itemId:row[1],itemName:item.nameAr,baseUnit:item.baseUnit,unit:item.baseUnit,periodMonth:row[2],startingBalance:row[5],totalIn:row[9],totalOut:row[8],balance:row[10],monthlyPurchases:row[15],monthlyReceived:row[16],monthlySent:row[17],monthlyNetMovement:row[18],balanceMovementStart:Utilities.formatDate(new Date(row[3]),Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm:ss'),monthlyMovementStart:Utilities.formatDate(new Date(row[19]),Session.getScriptTimeZone(),'yyyy-MM-dd HH:mm:ss'),calculatedAt:formatBalanceSnapshotDateTime_(row[11])};
    })};
    checkFormulaBalanceRuntime_(startedAtMs,'reader complete',plan.feed.length,plan.keys.length);
    return result;
  } catch(e) {
    console.error('getFormulaInventoryBalances failed',e);
    return {success:false,message:'الأرصدة غير متاحة حاليًا. حاول لاحقًا أو تواصل مع الإدارة.'};
  }
}

function setupFormulaInventoryBalances(sessionToken) {
  const startedAtMs=Date.now();
  const ss=SpreadsheetApp.getActiveSpreadsheet(); requireOwner_(ss,sessionToken);
  const lock=LockService.getScriptLock(); lock.waitLock(10000);
  try {
    requireOwner_(ss,sessionToken); inventorySubmissionSheet_(ss); assertSubmissionBalancesReady_(ss);
    checkFormulaBalanceRuntime_(startedAtMs,'setup preparation');
    [[FORMULA_BALANCE_SOURCE,FORMULA_BALANCE_SOURCE_HEADERS],[FORMULA_BALANCE_OUTPUT,FORMULA_BALANCE_HEADERS]].forEach(function(pair) {
      assertBalanceRuntimeBudget_(startedAtMs,'Formula setup table',FORMULA_BALANCE_RUNTIME_BUDGET_MS);
      let sheet=getSheetByNameCaseInsensitive_(ss,pair[0]);
      if(!sheet) sheet=ss.insertSheet(pair[0]);
      if(!sheet.getLastRow()) sheet.getRange(1,1,1,pair[1].length).setValues([pair[1]]);
      if(JSON.stringify(sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0])!==JSON.stringify(pair[1])) throw new Error('Formula schema mismatch; preserve existing table');
      sheet.setFrozenRows(1);
      const protections=sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET), protection=protections.length?protections[0]:sheet.protect();
      protection.setDescription('Inventory formula balances: derived data').setWarningOnly(false);
      protection.setUnprotectedRanges([]);
      const owner=Session.getEffectiveUser().getEmail(), editors=protection.getEditors().filter(function(u){return u.getEmail()!==owner;});
      if(editors.length) protection.removeEditors(editors);
      if(protection.canDomainEdit()) protection.setDomainEdit(false);
    });
  } finally { lock.releaseLock(); }
  try {
    checkFormulaBalanceRuntime_(startedAtMs,'setup tables ready');
    const input=readFormulaBalanceInputs_(ss);
    checkFormulaBalanceRuntime_(startedAtMs,'setup inputs ready');
    const refreshed=refreshFormulaBalanceTables_(ss,input,startedAtMs);
    requireOwner_(ss,sessionToken);
    checkFormulaBalanceRuntime_(startedAtMs,'activation');
    const props=PropertiesService.getScriptProperties(); props.setProperty(FORMULA_BALANCE_ENABLED,'1');
    if(props.getProperty(FORMULA_BALANCE_ENABLED)!=='1') throw new Error('Formula activation not retained');
    checkFormulaBalanceRuntime_(startedAtMs,'activation retained');
    const incomplete=Object.keys(refreshed.plan.incomplete).some(function(branch){return !!branch && branch!=='DISTRIBUTOR' && refreshed.plan.incomplete[branch];});
    return {success:true,runId:refreshed.ready.runId,warning:incomplete,message:'تم تجهيز أرصدة المعادلات دون تغيير الحركات أو الأرصدة التاريخية.'+(incomplete?' بعض الفروع غير متاحة بسبب بيانات غير مكتملة؛ راجع التشخيص.':'')};
  } catch(e) {
    console.error('setupFormulaInventoryBalances failed',e);
    return {success:false,message:'تعذر اعتماد أرصدة المعادلات. بقيت الحركات والسجلات التاريخية محفوظة؛ راجع التشخيص قبل إعادة التجهيز.'};
  }
}
// R02 FORMULA BALANCES END
