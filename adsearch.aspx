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

        string filter;
        string sigKey; // used in HMAC — tells Node which path was taken

        if (!string.IsNullOrEmpty(employeeId)) {
            // ── Employee-ID path: exact match on the employeeID attribute ──────────
            // Immune to name/email mismatches across domains.
            // Only accounts that have had employeeID set (via Set-ADUser -EmployeeID)
            // will be found this way.
            string esc = EscLdap(employeeId);
            filter = "(&(objectClass=user)(employeeID=" + esc + "))";
            sigKey = employeeId;
        } else {
            // ── Name/email path (existing behaviour) ─────────────────────────────
            if (q.Length < 2) {
                Response.StatusCode = 400;
                Response.Write("{\"error\":\"q or employeeId required (q min 2 chars)\"}");
                return;
            }
            string esc = EscLdap(q);
            filter = "(&(objectClass=user)"
                   +   "(!(userAccountControl:1.2.840.113556.1.4.803:=2))"
                   +   "(|(displayName=*" + esc + "*)"
                   +     "(sAMAccountName=*" + esc + "*)"
                   +     "(mail=*" + esc + "*)))";
            sigKey = q;
        }

        var results = new System.Collections.Generic.List<object>();

        // Try Global Catalog first — covers every domain in the ifl.net forest
        bool ok = false;
        if (!string.IsNullOrEmpty(gcHost))
            ok = TrySearch("LDAP://" + gcHost + ":3268", filter, results, 15);

        // Fallback: primary-domain LDAP (uses app-pool Windows identity, no explicit credentials)
        if (!ok || results.Count == 0)
            TrySearch(null, filter, results, 15);

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
                searcher.PropertiesToLoad.Add("mail");
                searcher.PropertiesToLoad.Add("title");
                searcher.PropertiesToLoad.Add("employeeID");
                searcher.PropertiesToLoad.Add("userAccountControl");
                searcher.PropertiesToLoad.Add("whenCreated");
                searcher.PropertiesToLoad.Add("memberOf");

                foreach (SearchResult r in searcher.FindAll()) {
                    string sam  = Prop(r, "sAMAccountName");
                    string name = Prop(r, "displayName");
                    if (string.IsNullOrEmpty(sam) || string.IsNullOrEmpty(name)) continue;

                    // userAccountControl — bit 1 (value 2) means disabled
                    int uac = 0;
                    if (r.Properties["userAccountControl"].Count > 0)
                        int.TryParse(r.Properties["userAccountControl"][0]?.ToString(), out uac);

                    // whenCreated — comes back as DateTime from DirectorySearcher
                    string createdAt = "";
                    try {
                        if (r.Properties["whenCreated"].Count > 0) {
                            var v = r.Properties["whenCreated"][0];
                            createdAt = (v is DateTime)
                                ? ((DateTime)v).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                                : v?.ToString() ?? "";
                        }
                    } catch {}

                    // memberOf — array of group DN strings
                    var grps = new System.Collections.Generic.List<string>();
                    foreach (var g in r.Properties["memberOf"])
                        if (g != null) grps.Add(g.ToString());

                    out_results.Add(new {
                        sAMAccountName  = sam,
                        displayName     = name,
                        mail            = Prop(r, "mail"),
                        email           = Prop(r, "mail"),   // alias — both keys for compat
                        title           = Prop(r, "title"),
                        employeeID      = Prop(r, "employeeID"),
                        accountEnabled  = (uac & 2) == 0,
                        userAccountControl = uac,
                        createdAt       = createdAt,
                        memberOf        = grps
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
