<%@ Page Language="C#" %>
<%@ Assembly Name="System.DirectoryServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=B03F5F7F11D50A3A" %>
<%@ Import Namespace="System.Security.Cryptography" %>
<%@ Import Namespace="System.Web.Script.Serialization" %>
<%@ Import Namespace="System.DirectoryServices" %>
<script runat="server">
    // CONFIGURATION — shares the same HMAC secret as token.aspx / SSO_SHARED_SECRET in Node .env
    string secretKey = System.Configuration.ConfigurationManager.AppSettings["SsoSharedSecret"];
    string gcHost    = System.Configuration.ConfigurationManager.AppSettings["GcHost"] ?? "";

    protected void Page_Load(object sender, EventArgs e)
    {
        Response.ContentType = "application/json";

        // Security: only the Node.js process on this machine may call this endpoint.
        // IIS allows anonymous auth for this file, so we enforce loopback-only here.
        string remoteAddr = Request.ServerVariables["REMOTE_ADDR"];
        if (remoteAddr != "127.0.0.1" && remoteAddr != "::1") {
            Response.StatusCode = 403;
            Response.Write("{\"error\":\"Forbidden\"}");
            return;
        }

        string email = (Request.QueryString["email"] ?? "").Trim().ToLower();
        if (string.IsNullOrEmpty(email)) {
            Response.StatusCode = 400;
            Response.Write("{\"error\":\"email query param required\"}");
            return;
        }

        // Search by mail OR userPrincipalName — covers all naming conventions in the forest.
        string filter = "(&(objectClass=user)(|(mail=" + Esc(email) + ")(userPrincipalName=" + Esc(email) + ")))";

        string sam  = "";
        string name = "";
        string mail = "";

        // ── Step 1: Global Catalog (covers all domains in the ifl.net forest) ───────
        if (!string.IsNullOrEmpty(gcHost) && !TryLdap("LDAP://" + gcHost + ":3268", filter, ref sam, ref name, ref mail)) {
            // GC unreachable or no result — fall through to primary-domain fallback below.
        }

        // ── Step 2: Primary-domain LDAP fallback ─────────────────────────────────────
        if (string.IsNullOrEmpty(sam)) {
            TryLdap(null, filter, ref sam, ref name, ref mail);
        }

        bool   found     = !string.IsNullOrEmpty(sam);
        long   timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string sig       = Sign(sam + "|" + timestamp + "|" + mail);

        Response.Write(new JavaScriptSerializer().Serialize(new {
            found          = found,
            sAMAccountName = sam,
            displayName    = name,
            mail           = mail,
            timestamp      = timestamp,
            signature      = sig
        }));
    }

    // Returns true if the user was found, false otherwise.
    bool TryLdap(string ldapPath, string filter, ref string sam, ref string name, ref string mail)
    {
        try {
            using (var root    = ldapPath != null ? new DirectoryEntry(ldapPath) : new DirectoryEntry())
            using (var srch    = new DirectorySearcher(root)) {
                srch.Filter = filter;
                srch.PropertiesToLoad.Add("sAMAccountName");
                srch.PropertiesToLoad.Add("displayName");
                srch.PropertiesToLoad.Add("mail");
                srch.SizeLimit = 1;
                SearchResult r = srch.FindOne();
                if (r == null) return false;
                sam  = Prop(r, "sAMAccountName");
                name = Prop(r, "displayName");
                mail = Prop(r, "mail");
                return true;
            }
        } catch (Exception ex) {
            try { System.Diagnostics.EventLog.WriteEntry("adlookup.aspx",
                    (ldapPath ?? "primary") + ": " + ex.Message,
                    System.Diagnostics.EventLogEntryType.Warning); } catch { }
            return false;
        }
    }

    string Prop(SearchResult r, string key)
    {
        return (r.Properties[key].Count > 0) ? (r.Properties[key][0] ?? "").ToString() : "";
    }

    string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\5c").Replace("*", "\\2a")
                .Replace("(",  "\\28").Replace(")", "\\29").Replace("\0", "\\00");
    }

    string Sign(string data)
    {
        using (var h = new HMACSHA256(System.Text.Encoding.UTF8.GetBytes(secretKey ?? "")))
        {
            return BitConverter.ToString(h.ComputeHash(
                System.Text.Encoding.UTF8.GetBytes(data))).Replace("-", "").ToLower();
        }
    }
</script>
