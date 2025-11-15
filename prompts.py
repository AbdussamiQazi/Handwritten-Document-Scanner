# prompts.py - Centralized prompt management

# ========== EXTRACTION PROMPT ==========
EXTRACTION_PROMPT =("""Extract ALL text from these images exactly as written.
IMPORTANT:
- Preserve the exact spelling, grammar, and formatting including errors 
- Translate it to English
- Maintain line breaks and paragraph structure
- Include all symbols, numbers, and special characters
- Do not correct any mistakes or add any interpretation
- If text is unclear, write [UNREADABLE] for that portion
- Extract everything you can see
- Do not put any markdown like (**)""")


# ========== FORMATTING PROMPT ==========
FORMAT_PROMPT = (
    """Analyze the following text and reformat it into a clean, structured document.
        
        Instructions:
        
        1. If it's an insurance claim form, organize it with clear field names and values
        
        2. If it's a letter, format with proper paragraphs, salutation, and closing
        
        3. If it's a general document, structure it with clear sections
        
        4. Maintain all original information and wording
        
        5. Do not correct spelling or grammar errors
        
        6. Use clear headings and organization
        
        7. Do not use any markdowns like ( ** , etc.) 
        
        Text to format:"""
)

# ========== SUMMARIZATION PROMPT ==========
SUMMARY_PROMPT = (
    """Generate a concise, narrative summary of the following insurance document. Follow this exact format without excessive spacing:
Key People & Roles:

- [Person 1]: [Role]
- [Person 2]: [Role]


Vehicle Information:
- [Vehicle details, registration numbers]


Incident Details:

- Date: [Date of incident]

- Time: [Time of incident]

- Location: [Location of incident]

- Description: [Brief description of what happened]


Additional Notes:
- [Any other important information]
-Avoid redundant information and wasted vertical and horizontal space in both formats.

Summary: [2-3 sentence narrative summary in the style of the provided examples]

Example 1: "Usama Rehan (Insured) is the owner of the IV(Toyota Innova) car bearing registration number TN-22-BS-4671). Insured uses the IV for personal use only. Abdul khader (Insured's Friend) took the IV from Insured.Mohhamad Attaul Haseeb (Alleged driver) son of the Abdul khader (Insured's Friend). On 14-01-2025 afternoon Insured got a call stating that his IV met with an accident. Since Abdul khader (Insured's Friend).Abdul khader (Insured's Friend) was in critical condition due to accident."

Example 2: "Pravesh Brijdeo Mishra is the registered owner of the insured vehicle (Tata LPT 3518 Truck, bearing Reg. No. MH-04-KU-7942). Naseem Khan is the alleged driver,On date 18/02/2025 at around 01:00 AM, when Naseem Khan (Alleged driver), was operating the (IV) near Sangrur Bus Stand, Partap Nagar, an unknown vehicle (TPV) approached from another route and had a head-on collision with the (IV). As a result, the accident occurred, causing significant damage to the (IV).In the said accident, Naseem Khan (Alleged driver) did not sustain any injuries; however, no F.I.R. was lodged regarding the said incident."
"""
)

PROMPT_CONFIG = {
    "extraction": EXTRACTION_PROMPT,
    "formatting": FORMAT_PROMPT,
    "summarization": SUMMARY_PROMPT,
    "version": "1.0"
}

def get_prompt(prompt_type):
    """Safely get a prompt by type"""
    return PROMPT_CONFIG.get(prompt_type, "")

# Validate prompts on import
required_prompts = ["extraction", "formatting", "summarization"]
missing = [p for p in required_prompts if p not in PROMPT_CONFIG]
if missing:
    print(f"❌ Missing required prompts: {missing}")
else:
    print("✅ All prompts loaded successfully")

if __name__ == "__main__":
    # Test the prompts
    print("Prompt System Test:")
    for prompt_type in required_prompts:
        prompt = get_prompt(prompt_type)
        print(f"  {prompt_type}: {len(prompt)} characters")