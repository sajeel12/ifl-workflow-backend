<%@ Page Language="C#" %>
<%@ Import Namespace="System.Security.Cryptography" %>
<%@ Import Namespace="System.Web.Script.Serialization" %>
<script runat="server">
    protected void Page_Load(object sender, EventArgs e)
    {
        // CONFIGURATION: Keep this secure and same as Node.js .env
        // In production, move this to Web.config <appSettings>
        string secretKey = "IFL_WORKFLOW_SECRET_KEY_2025"; 

        Response.ContentType = "application/json";
        
        // Get the current windows user
        string username = User.Identity.Name;
        // string username = "IFL\\DevDefault"; // Uncomment for local testing without IIS Auth

        if (string.IsNullOrEmpty(username))
        {
            Response.StatusCode = 401;
            Response.Write("{\"error\": \"Not Authenticated\"}");
            return;
        }

        // Create Payload
        long timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        // Create Signature (HMACSHA256)
        // Format: username|timestamp
        string dataToSign = username + "|" + timestamp;
        string signature = ComputeHmacSha256(dataToSign, secretKey);

        // Return JSON
        var result = new {
            username = username,
            timestamp = timestamp,
            signature = signature
        };
        
        JavaScriptSerializer js = new JavaScriptSerializer();
        Response.Write(js.Serialize(result));
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
