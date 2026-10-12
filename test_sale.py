import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page()
    page.goto('http://localhost:1420')
    page.wait_for_load_state('networkidle')
    
    # Fill in the activation key
    page.fill('input[placeholder="MOBI-LIFE-XXXX-XXXX"]', 'MOBI-LIFE-KSXF-HTV4')
    page.fill('input[placeholder="ex: Caisse Principale, Tablette Vendeur"]', 'Caisse Principale')
    
    # Click Activer la Licence
    page.click('button:has-text("Activer la Licence")')
    
    # Wait for navigation
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(3000)
    
    # Now we're at the first-boot PIN setup screen
    # Fill in manager name
    page.fill('input[placeholder="Ex. Yacine"]', 'Yacine')
    
    # Fill in manager PIN (6+ digits)
    page.fill('input[aria-label="PIN gérant (6 chiffres minimum)"]', '123456')
    
    # Confirm PIN
    page.fill('input[aria-label="Confirmer le PIN"]', '123456')
    
    # Click the submit button
    page.click('button:has-text("Enregistrer l\'équipe et déverrouiller")')
    
    # Wait for navigation
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(3000)
    
    page.screenshot(path='after_pin_setup.png', full_page=True)
    print('=== Page text after PIN setup ===')
    print(page.locator('body').inner_text()[:3000])
    
    browser.close()