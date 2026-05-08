<%@ Page Language="C#" %>
    <%@ Import Namespace="System.Security.Cryptography" %>
        <%@ Import Namespace="System.Web.Script.Serialization" %>
            <%@ Import Namespace="System.DirectoryServices.AccountManagement" %>
                <script runat="server">
    protected void Page_Load(object sender, EventArgs e)
                    {
        string secretKey = "IFL_WORKFLOW_SECRET_KEY_2025";
                        Response.ContentType = "application/json";

        string username = User.Identity.Name;        // e.g. "IFL\sajeel.dilshad"
                        if (string.IsNullOrEmpty(username)) {
                            Response.StatusCode = 401;
                            Response.Write("{\"error\":\"Not Authenticated\"}");
                            return;
                        }

        // ── NEW: pull profile fields from AD via the App Pool identity ──
        string email = "", displayName = "", manager = "";
                        try {
            string sam = username.Contains("\\") ? username.Split('\\')[1] : username;
                            using(var ctx = new PrincipalContext(ContextType.Domain)) {
                                var u = UserPrincipal.FindByIdentity(ctx, sam);
                            if (u != null) {
                                email = u.EmailAddress ?? "";
                                displayName = u.DisplayName ?? "";
                                // optional: manager DN if you need it
                            }
                        }
        } catch (Exception ex) {
                        // swallow — return what we have. Node will fall back to username if email is empty.
                    }

        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // Sign over username + timestamp + email + displayName so they can't be tampered with
        string dataToSign = username + "|" + timestamp + "|" + email + "|" + displayName;
        string signature = ComputeHmacSha256(dataToSign, secretKey);

                    var result = new {
                        username    = username,
                        email       = email,
                        displayName = displayName,
                        timestamp   = timestamp,
                        signature   = signature
                    };
                    new JavaScriptSerializer().Serialize(result, Response.Output);
    }

    private string ComputeHmacSha256(string data, string key) {
                        using(var hmac = new HMACSHA256(System.Text.Encoding.UTF8.GetBytes(key))) {
                            byte[] hash = hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes(data));
                        return BitConverter.ToString(hash).Replace("-", "").ToLower();
                    }
    }
                </script>