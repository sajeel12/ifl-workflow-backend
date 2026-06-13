<%@ Page Language="C#" %>
<%@ Assembly Name="System.DirectoryServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=B03F5F7F11D50A3A" %>
<%@ Import Namespace="System.Security.Cryptography" %>
<%@ Import Namespace="System.Web.Script.Serialization" %>
<%@ Import Namespace="System.DirectoryServices" %>
<script runat="server">
    // Shared with token.aspx / adlookup.aspx — must match SSO_SHARED_SECRET in Node .env
    string secretKey = System.Configuration.ConfigurationManager.AppSettings["SsoSharedSecret"];
    string gcHost    = System.Configuration.ConfigurationManager.AppSettings["GcHost"] ?? "";

    protected void Page_Load(object sender, EventArgs e)
    {
        Response.ContentType = "application/json";

        // Loopback-only — called exclusively by the Node.js process on this machine
        string remoteAddr = Request.ServerVariables["REMOTE_ADDR"];
        if (remoteAddr != "127.0.0.1" && remoteAddr != "::1") {
            Response.StatusCode = 403;
            Response.Write("{\"error\":\"Forbidden\"}");
            return;
        }

        string q          = (Request.QueryString["q"]          ?? "").Trim();
        string employeeId = (Request.QueryString["employeeId"] ?? "").Trim();
        string groups     = (Request.QueryString["groups"]     ?? "").Trim();
        string computer   = (Request.QueryString["computer"]   ?? "").Trim();
        string login      = (Request.QueryString["login"]      ?? "").Trim();

        string filter;
        string sigKey; // used in HMAC — tells Node which path was taken
        int    limit = 15;
        // primaryFirst: query the primary-domain LDAP BEFORE the Global Catalog.
        // The GC does not replicate the employeeID attribute, so a GC-first search
        // returns the account with an EMPTY employeeID. The login path needs
        // employeeID, so it queries primary-domain LDAP first (employeeID lives
        // there), then falls back to the GC for child-domain accounts.
        bool primaryFirst = false;

        if (!string.IsNullOrEmpty(computer)) {
            // ── Computer path: search COMPUTER objects (objectCategory=computer) ──
            // Used by the OPS Desk-Setup hostname cross-check — confirms the machine
            // the OPS user typed was actually joined to the domain. A computer's
            // sAMAccountName is "HOSTNAME$"; its cn / name / dNSHostName carry the
            // bare hostname, so we match on all of them.
            if (computer.Length < 2) {
                Response.StatusCode = 400;
                Response.Write("{\"error\":\"computer min 2 chars\"}");
                return;
            }
            string esc = EscLdap(computer);
            filter = "(&(objectCategory=computer)"
                   +   "(|(cn=*" + esc + "*)"
                   +     "(name=*" + esc + "*)"
                   +     "(dNSHostName=*" + esc + "*)"
                   +     "(sAMAccountName=*" + esc + "*)))";
            sigKey = "computer:" + computer;
            limit  = 25;
        } else if (!string.IsNullOrEmpty(groups)) {
            // ── Group path: list/search GROUP objects (objectClass=group) ─────────
            // groups=all (or 1) → every group, for the DCI form's load-once dropdown.
            // groups=<text>     → substring search on cn / sAMAccountName / mail.
            if (groups == "all" || groups == "1") {
                filter = "(objectClass=group)";
                sigKey = "group:all";
                limit  = 2000;
            } else {
                string esc = EscLdap(groups);
                filter = "(&(objectClass=group)"
                       +   "(|(cn=*" + esc + "*)"
                       +     "(sAMAccountName=*" + esc + "*)"
                       +     "(mail=*" + esc + "*)))";
                sigKey = "group:" + groups;
                limit  = 50;
            }
        } else if (!string.IsNullOrEmpty(employeeId)) {
            // ── Employee-ID path: exact match on the employeeID attribute ──────────
            // Immune to name/email mismatches across domains.
            // Only accounts that have had employeeID set (via Set-ADUser -EmployeeID)
            // will be found this way.
            string esc = EscLdap(employeeId);
            // objectCategory=person excludes COMPUTER accounts (which are also
            // objectClass=user in AD — the computer class derives from user).
            // Without this a machine account like HOSTNAME$ that happens to carry
            // an employeeID would be returned as if it were the employee.
            filter = "(&(objectCategory=person)(objectClass=user)(employeeID=" + esc + "))";
            sigKey = employeeId;
        } else if (!string.IsNullOrEmpty(login)) {
            // ── Login path: exact sAMAccountName match, employeeID guaranteed ──────
            // Resolves a logged-in NT account to its employeeID. Queries the
            // primary-domain LDAP first (the GC does not hold employeeID), so the
            // returned record reliably carries employeeID for the DB pivot.
            if (login.Length < 2) {
                Response.StatusCode = 400;
                Response.Write("{\"error\":\"login min 2 chars\"}");
                return;
            }
            string esc = EscLdap(login);
            filter = "(&(objectCategory=person)(objectClass=user)(sAMAccountName=" + esc + "))";
            sigKey = "login:" + login;
            primaryFirst = true;
        } else {
            // ── Name/email path (existing behaviour) ─────────────────────────────
            if (q.Length < 2) {
                Response.StatusCode = 400;
                Response.Write("{\"error\":\"q, employeeId or groups required (q min 2 chars)\"}");
                return;
            }
            string esc = EscLdap(q);
            // objectCategory=person keeps COMPUTER accounts out of name/email
            // search results — they are objectClass=user too, so a substring like
            // "muhammad" would otherwise match a machine account "ALIMUHAMMADHP$".
            filter = "(&(objectCategory=person)(objectClass=user)"
                   +   "(!(userAccountControl:1.2.840.113556.1.4.803:=2))"
                   +   "(|(displayName=*" + esc + "*)"
                   +     "(sAMAccountName=*" + esc + "*)"
                   +     "(mail=*" + esc + "*)))";
            sigKey = q;
        }

        var results = new System.Collections.Generic.List<object>();

        if (primaryFirst) {
            // Primary-domain LDAP first — it holds the employeeID attribute that the
            // Global Catalog does not replicate. GC is the fallback for accounts in
            // child domains that the primary-domain bind cannot see.
            bool ok = TrySearch(null, filter, results, limit);
            if ((!ok || results.Count == 0) && !string.IsNullOrEmpty(gcHost))
                TrySearch("LDAP://" + gcHost + ":3268", filter, results, limit);
        } else {
            // Try Global Catalog first — covers every domain in the ifl.net forest
            bool ok = false;
            if (!string.IsNullOrEmpty(gcHost))
                ok = TrySearch("LDAP://" + gcHost + ":3268", filter, results, limit);

            // Fallback: primary-domain LDAP (uses app-pool Windows identity, no explicit credentials)
            if (!ok || results.Count == 0)
                TrySearch(null, filter, results, limit);
        }

        long   timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string sig       = Sign("search|" + sigKey + "|" + timestamp + "|" + results.Count);

        Response.Write(new JavaScriptSerializer().Serialize(new {
            results   = results,
            timestamp = timestamp,
            signature = sig
        }));
    }

    bool TrySearch(string ldapPath, string filter,
                   System.Collections.Generic.List<object> out_results, int limit)
    {
        try {
            using (var root    = ldapPath != null ? new DirectoryEntry(ldapPath) : new DirectoryEntry())
            using (var searcher = new DirectorySearcher(root)) {
                searcher.Filter    = filter;
                searcher.SizeLimit = limit;
                searcher.PageSize  = limit;
                searcher.PropertiesToLoad.Add("sAMAccountName");
                searcher.PropertiesToLoad.Add("displayName");
                searcher.PropertiesToLoad.Add("cn");
                searcher.PropertiesToLoad.Add("mail");
                searcher.PropertiesToLoad.Add("title");
                searcher.PropertiesToLoad.Add("employeeID");
                searcher.PropertiesToLoad.Add("userAccountControl");
                searcher.PropertiesToLoad.Add("whenCreated");
                searcher.PropertiesToLoad.Add("memberOf");
                searcher.PropertiesToLoad.Add("physicalDeliveryOfficeName");
                searcher.PropertiesToLoad.Add("telephoneNumber");
                searcher.PropertiesToLoad.Add("mobile");
                searcher.PropertiesToLoad.Add("l");
                searcher.PropertiesToLoad.Add("streetAddress");
                searcher.PropertiesToLoad.Add("dNSHostName");
                searcher.PropertiesToLoad.Add("operatingSystem");

                foreach (SearchResult r in searcher.FindAll()) {
                    string sam  = Prop(r, "sAMAccountName");
                    // Groups carry cn but often no displayName — fall back to cn.
                    string name = Prop(r, "displayName");
                    if (string.IsNullOrEmpty(name)) name = Prop(r, "cn");
                    if (string.IsNullOrEmpty(sam) && string.IsNullOrEmpty(name)) continue;

                    // userAccountControl — bit 1 (value 2) means disabled
                    // NOTE: no C# 6 null-conditional (?.) — the inline ASPX compiler
                    // on this server is C# 5; ?. causes a compile error (HTTP 500).
                    int uac = 0;
                    if (r.Properties["userAccountControl"].Count > 0) {
                        object uacVal = r.Properties["userAccountControl"][0];
                        if (uacVal != null) int.TryParse(uacVal.ToString(), out uac);
                    }

                    // whenCreated — comes back as DateTime from DirectorySearcher
                    string createdAt = "";
                    try {
                        if (r.Properties["whenCreated"].Count > 0) {
                            object v = r.Properties["whenCreated"][0];
                            if (v is DateTime)
                                createdAt = ((DateTime)v).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ");
                            else if (v != null)
                                createdAt = v.ToString();
                        }
                    } catch {}

                    // memberOf — array of group DN strings
                    var grps = new System.Collections.Generic.List<string>();
                    foreach (var g in r.Properties["memberOf"])
                        if (g != null) grps.Add(g.ToString());

                    out_results.Add(new {
                        name            = name,
                        sAMAccountName  = sam,
                        displayName     = name,
                        mail            = Prop(r, "mail"),
                        email           = Prop(r, "mail"),   // alias — both keys for compat
                        title           = Prop(r, "title"),
                        employeeID      = Prop(r, "employeeID"),
                        accountEnabled  = (uac & 2) == 0,
                        userAccountControl = uac,
                        createdAt       = createdAt,
                        memberOf        = grps,
                        office          = Prop(r, "physicalDeliveryOfficeName"),
                        telephoneNumber = Prop(r, "telephoneNumber"),
                        mobile          = Prop(r, "mobile"),
                        locality        = Prop(r, "l"),
                        streetAddress   = Prop(r, "streetAddress"),
                        dNSHostName     = Prop(r, "dNSHostName"),
                        operatingSystem = Prop(r, "operatingSystem")
                    });
                }
                return true;
            }
        } catch (Exception ex) {
            try { System.Diagnostics.EventLog.WriteEntry("adsearch.aspx",
                    (ldapPath ?? "primary") + ": " + ex.Message,
                    System.Diagnostics.EventLogEntryType.Warning); } catch { }
            return false;
        }
    }

    string Prop(SearchResult r, string key)
    {
        return r.Properties[key].Count > 0 ? (r.Properties[key][0] ?? "").ToString() : "";
    }

    string EscLdap(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\5c").Replace("*",  "\\2a")
                .Replace("(",  "\\28").Replace(")",  "\\29").Replace("\0", "\\00");
    }

    string Sign(string data)
    {
        using (var h = new HMACSHA256(System.Text.Encoding.UTF8.GetBytes(secretKey ?? "")))
            return BitConverter.ToString(
                h.ComputeHash(System.Text.Encoding.UTF8.GetBytes(data))).Replace("-","").ToLower();
    }
</script>
