#Requires -Module ActiveDirectory

# Test: Set employeeID for a single employee before running bulk script
# Employee : Ijaz Ahmad
# Email    : ijaz.ahmad@igc.com.pk
# SAM      : IJAZAHMAD
# EmpID    : 120723

Write-Host "Before:" -ForegroundColor Cyan
Get-ADUser -Identity "IJAZAHMAD" -Properties EmployeeID | Select-Object Name, SamAccountName, EmployeeID

Set-ADUser -Identity "IJAZAHMAD" -EmployeeID "120723"

Write-Host "`nAfter:" -ForegroundColor Green
Get-ADUser -Identity "IJAZAHMAD" -Properties EmployeeID | Select-Object Name, SamAccountName, EmployeeID
