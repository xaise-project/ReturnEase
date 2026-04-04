async function main() {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer re_b6tVcYvU_MyufkSgwmvjVCdnVr4ynft4R`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "returnease01@gmail.com",
      to: "returnease01@gmail.com",
      subject: "Test",
      html: "Test email",
    }),
  });
  console.log(response.status);
  console.log(await response.text());
}
main();
