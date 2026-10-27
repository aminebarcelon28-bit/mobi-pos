import subprocess

ps_script = """
Get-CimInstance Win32_Process -Filter "name = 'mobi-pos.exe'" | Select-Object ProcessId, CommandLine, CreationDate | Format-List
"""

res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], capture_output=True, text=True)
print(res.stdout)

