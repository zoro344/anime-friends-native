const http = require("http");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Username: ", username => {
  rl.question("Password: ", password => {
    const data = JSON.stringify({ username, password });

    const req = http.request("http://127.0.0.1:3000/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    }, res => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const result = JSON.parse(body);
          if (result.token) {
            require("fs").writeFileSync(".news-token", result.token, { mode: 0o600 });
            console.log("Login successful. Token saved locally.");
          } else {
            console.log("Login failed:", result.message || "Unknown error");
          }
        } catch {
          console.log("Invalid server response.");
        }
        rl.close();
      });
    });

    req.on("error", error => {
      console.log("Connection error:", error.message);
      rl.close();
    });

    req.end(data);
  });
});
