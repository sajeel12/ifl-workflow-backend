<%@ Page Language="C#" %>
<%@ Assembly Name="System.DirectoryServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=B03F5F7F11D50A3A" %>
<%@ Import Namespace="System.Security.Cryptography" %>
<%@ Import Namespace="System.Web.Script.Serialization" %>
<%@ Import Namespace="System.DirectoryServices" %>
<script runat="server">
    // CONFIGURATION — must match SSO_SHARED_SECRET in the Node .env
    string secretKey = System.Configuration.ConfigurationManager.AppSettings["SsoSharedSecret"];
    // GC server for the ifl.net forest — covers all child domains (lhr.ifl.net etc.)
    // Update GcHost in web.config if the GC server changes.
    string gcHost    = System.Configuration.ConfigurationManager.AppSettings["GcHost"] ?? "";

    protected void Page_Load(object sender, EventArgs e)
    {
        Response.ContentType = "application/json";

        string username = User.Identity.Name; // e.g. "IFL\sajeel.dilshad" or "IBRAHIM5_NT\muhammaddaniyal"
        if (string.IsNullOrEmpty(username)) {
            Response.StatusCode = 401;
            Response.Write("{\"error\":\"Not Authenticated\"}");
            return;
        }

        string email       = "";
        string displayName = "";

        // Strip "DOMAIN\" prefix — keep sAMAccountName only.
        string sam    = username.Contains("\\") ? username.Split('\\')[1] : username;
        string filter = "(&(objectClass=user)(sAMAccountName=" + EscapeLdap(sam) + "))";

        // ── Step 1: Global Catalog via LDAP port 3268 ───────────────────────────
        // Covers every domain in the ifl.net forest including child domains
        // (lhr.ifl.net / IBRAHIM5_NT etc.). GcHost is set in web.config.
        bool gcFound = false;
        if (!string.IsNullOrEmpty(gcHost)) {
            try {
                using (var gcRoot   = new DirectoryEntry("LDAP://" + gcHost + ":3268"))
                using (var searcher = new DirectorySearcher(gcRoot))
                {
                    searcher.Filter = filter;
                    searcher.PropertiesToLoad.Add("mail");
                    searcher.PropertiesToLoad.Add("displayName");
                    searcher.SizeLimit = 1;

                    SearchResult r = searcher.FindOne();
                    if (r != null) {
                        gcFound = true;
                        if (r.Properties["mail"].Count > 0)
                            email = (r.Properties["mail"][0] ?? "").ToString();
                        if (r.Properties["displayName"].Count > 0)
                            displayName = (r.Properties["displayName"][0] ?? "").ToString();
                    }
                }
            } catch (Exception ex) {
                try { System.Diagnostics.EventLog.WriteEntry("token.aspx", "GC lookup failed: " + ex.Message, System.Diagnostics.EventLogEntryType.Warning); } catch { }
            }
        }

        // ── Step 2: Current-domain LDAP fallback ────────────────────────────────
        // Covers primary ifl.net users when GC is temporarily unavailable.
        if (!gcFound) {
            try {
                using (var root    = new DirectoryEntry())
                using (var searcher = new DirectorySearcher(root))
                {
                    searcher.Filter = filter;
                    searcher.PropertiesToLoad.Add("mail");
                    searcher.PropertiesToLoad.Add("displayName");
                    searcher.SizeLimit = 1;

                    SearchResult r = searcher.FindOne();
                    if (r != null) {
                        if (r.Properties["mail"].Count > 0)
                            email = (r.Properties["mail"][0] ?? "").ToString();
                        if (r.Properties["displayName"].Count > 0)
                            displayName = (r.Properties["displayName"][0] ?? "").ToString();
                    }
                }
            } catch (Exception ex) {
                try { System.Diagnostics.EventLog.WriteEntry("token.aspx", "LDAP fallback failed: " + ex.Message, System.Diagnostics.EventLogEntryType.Warning); } catch { }
            }
        }

        long   timestamp  = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string dataToSign = username + "|" + timestamp + "|" + email + "|" + displayName;
        string signature  = ComputeHmacSha256(dataToSign, secretKey);

        var result = new {
            username    = username,
            email       = email,
            displayName = displayName,
            timestamp   = timestamp,
            signature   = signature
        };
        Response.Write(new JavaScriptSerializer().Serialize(result));
    }

    private string EscapeLdap(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\5c")
                .Replace("*",  "\\2a")
                .Replace("(",  "\\28")
                .Replace(")",  "\\29")
                .Replace("\0", "\\00");
    }

    private string ComputeHmacSha256(string data, string key)
    {
        using (var hmac = new HMACSHA256(System.Text.Encoding.UTF8.GetBytes(key)))
        {
            byte[] hash = hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes(data));
            return BitConverter.ToString(hash).Replace("-", "").ToLower();
        }
    }
</script>
