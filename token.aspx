<%@ Page Language="C#" %>
    <%@ Assembly Name="System.DirectoryServices, Version=4.0.0.0, Culture=neutral, PublicKeyToken=B03F5F7F11D50A3A" %>
        <%@ Import Namespace="System.Security.Cryptography" %>
            <%@ Import Namespace="System.Web.Script.Serialization" %>
                <%@ Import Namespace="System.DirectoryServices" %>
                    <script runat="server">
    // CONFIGURATION — must match SSO_SHARED_SECRET in the Node .env
    string secretKey = System.Configuration.ConfigurationManager.AppSettings["SsoSharedSecret"];

    protected void Page_Load(object sender, EventArgs e)
                        {
                            Response.ContentType = "application/json";

        string username = User.Identity.Name; // e.g. "IFL\sajeel.dilshad"
                            if (string.IsNullOrEmpty(username)) {
                                Response.StatusCode = 401;
                                Response.Write("{\"error\":\"Not Authenticated\"}");
                                return;
                            }

        // Profile lookup using System.DirectoryServices (always present on
        // domain-joined Windows Server — no AccountManagement assembly needed).
        string email = "";
        string displayName = "";
                            try {
            string sam = username.Contains("\\") ? username.Split('\\')[1] : username;
                                using(var root = new DirectoryEntry())
                                    using (var searcher = new DirectorySearcher(root))
                                        {
                                            searcher.Filter = "(&(objectClass=user)(sAMAccountName=" + EscapeLdap(sam) + "))";
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
        }
        catch (Exception ex)
                        {
                            // Don't surface AD errors to the client — log to event viewer and
                            // return what we have. Node will fall back to username if email is empty.
                            try { System.Diagnostics.EventLog.WriteEntry("token.aspx", ex.ToString(), System.Diagnostics.EventLogEntryType.Warning); } catch { }
                        }

        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // Sign over username + timestamp + email + displayName so they can't
        // be tampered with in transit.
        string dataToSign = username + "|" + timestamp + "|" + email + "|" + displayName;
        string signature = ComputeHmacSha256(dataToSign, SECRET_KEY);

                        var result = new
                            {
                                username    = username,
                                email       = email,
                                displayName = displayName,
                                timestamp   = timestamp,
                                signature   = signature
                            };
                        Response.Write(new JavaScriptSerializer().Serialize(result));
    }

    // Escape LDAP filter special characters per RFC 4515.
    private string EscapeLdap(string s)
                        {
                            if (string.IsNullOrEmpty(s)) return "";
                            return s.Replace("\\", "\\5c")
                                .Replace("*", "\\2a")
                                .Replace("(", "\\28")
                                .Replace(")", "\\29")
                                .Replace("\0", "\\00");
                        }

    private string ComputeHmacSha256(string data, string key)
                        {
                            using(var hmac = new HMACSHA256(System.Text.Encoding.UTF8.GetBytes(key)))
                                {
                                    byte[] hash = hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes(data));
                            return BitConverter.ToString(hash).Replace("-", "").ToLower();
                        }
    }
                    </script>