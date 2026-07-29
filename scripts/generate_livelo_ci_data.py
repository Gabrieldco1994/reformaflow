#!/usr/bin/env python3
"""
Gerador de Dados Sintéticos Livelo para Microsoft Dynamics 365 Customer Insights (CI / CDP)
Atende aos requisitos de dados dos modelos de IA/ML do D365 CI:
1. Customer Lifetime Value (CLV)
2. Product Recommendation
3. Transactional Churn
"""

import csv
import os
import random
from datetime import datetime, timedelta, timezone

# Configurações de tamanho da base
NUM_CUSTOMERS = 1000
NUM_PRODUCTS = 50
NUM_TRANSACTIONS = 10000
NUM_INTERACTIONS = 20000
NUM_CASES = 3500

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "livelo_ci_csv")

# Dados de apoio PT-BR
FIRST_NAMES = [
    "Ana", "Bruno", "Carla", "Daniel", "Eduardo", "Fernanda", "Gabriel", "Helena",
    "Igor", "Juliana", "Lucas", "Mariana", "Natan", "Olivia", "Paulo", "Rafaela",
    "Rodrigo", "Sofia", "Thiago", "Beatriz", "Caio", "Camila", "Diego", "Larissa",
    "Marcelo", "Patricia", "Renato", "Vanessa", "Vinicius", "Yasmin"
]

LAST_NAMES = [
    "Silva", "Santos", "Oliveira", "Souza", "Rodrigues", "Ferreira", "Alves",
    "Pereira", "Lima", "Gomes", "Costa", "Ribeiro", "Martins", "Carvalho",
    "Almeida", "Lopes", "Soares", "Fernandes", "Vieira", "Barbosa"
]

CITIES_STATES = [
    ("São Paulo", "SP"), ("Rio de Janeiro", "RJ"), ("Belo Horizonte", "MG"),
    ("Curitiba", "PR"), ("Porto Alegre", "RS"), ("Campinas", "SP"),
    ("Salvador", "BA"), ("Brasília", "DF"), ("Fortaleza", "CE"),
    ("Recife", "PE"), ("Goiânia", "GO"), ("Florianópolis", "SC")
]

TIERS = ["Bronze", "Prata", "Ouro", "Topázio", "Clube Livelo 1k", "Clube Livelo 5k", "Clube Livelo 10k", "Clube Livelo 20k"]

CATEGORIES = {
    "Viagens": [
        ("Passagem Aérea SP - Rio de Janeiro (Ida e Volta)", 18000, 360.00),
        ("Passagem Aérea SP - Miami (Ida e Volta)", 120000, 2400.00),
        ("Diária Hotel Resort All Inclusive Porto de Galinhas", 35000, 700.00),
        ("Aluguel de Carro Categoria SUV (3 Diárias)", 25000, 500.00),
        ("Pacote de Viagem Lisboa 5 Noites", 220000, 4400.00),
        ("Passagem Aérea SP - Salvador", 22000, 440.00),
        ("Passagem Aérea SP - Buenos Aires", 45000, 900.00),
        ("Passeio de Lancha em Angra dos Reis", 15000, 300.00),
        ("Seguro Viagem Internacional 7 Dias", 8000, 160.00),
        ("Diária Hotel Executivo Faria Lima SP", 18000, 360.00)
    ],
    "Eletrônicos": [
        ("Smartphone Samsung Galaxy S24 256GB", 250000, 5000.00),
        ("Apple iPhone 15 128GB", 320000, 6400.00),
        ("Fone de Ouvido Bluetooth Noise Cancelling Sony", 65000, 1300.00),
        ("Smart TV 55'' 4K UHD LG", 140000, 2800.00),
        ("Notebook Dell Inspiron Intel i7 16GB", 210000, 4200.00),
        ("Caixa de Som JBL Charge 5", 35000, 700.00),
        ("Tablet Apple iPad 10ª Geração 64GB", 180000, 3600.00),
        ("Relógio Apple Watch SE", 120000, 2400.00),
        ("Console PlayStation 5 825GB", 230000, 4600.00),
        ("Kindle Paperwhite 16GB", 30000, 600.00)
    ],
    "Casa e Cozinha": [
        ("Jogo de Panelas Tramontina Inox 5 Peças", 25000, 500.00),
        ("Cafeteira Nespresso Essenza Mini", 20000, 400.00),
        ("Fritadeira Air Fryer Philips Walita 4.1L", 30000, 600.00),
        ("Robô Aspirador de Pó Eufy RoboVac", 55000, 1100.00),
        ("Liquidificador Oster 1400W", 12000, 240.00),
        ("Aparelho de Jantar Oxford 20 Peças", 18000, 360.00),
        ("Adega Climatizada 12 Garrafas Brastemp", 80000, 1600.00),
        ("Batedeira Planetária KitchenAid", 130000, 2600.00),
        ("Jogo de Cama 200 Fios Casal Buddemeyer", 22000, 440.00),
        ("Purificador de Água Consul", 15000, 300.00)
    ],
    "Gift Cards & Vouchers": [
        ("Voucher Uber R$ 100", 5000, 100.00),
        ("Voucher iFood R$ 150", 7500, 150.00),
        ("Gift Card OutBack R$ 200", 10000, 200.00),
        ("Crédito Shell Box R$ 100", 5000, 100.00),
        ("Cartão Boticário R$ 150", 7500, 150.00),
        ("Voucher Renner R$ 200", 10000, 200.00),
        ("Gift Card Steam R$ 100", 5000, 100.00),
        ("Assinatura Spotify Premium 6 Meses", 6000, 120.00),
        ("Assinatura Netflix 3 Meses", 8000, 160.00),
        ("Crédito Cacau Show R$ 100", 5000, 100.00)
    ],
    "Transferência de Pontos": [
        ("Transferência Pontos Azul Fidelidade (10.000 pts)", 10000, 200.00),
        ("Transferência Pontos LATAM Pass (10.000 pts)", 10000, 200.00),
        ("Transferência Milhas Smiles (10.000 pts)", 10000, 200.00),
        ("Transferência TAP Miles&Go (10.000 pts)", 12000, 240.00),
        ("Transferência ALL Accor Live Limitless (2.000 pts)", 16000, 320.00),
        ("Bonus Transferência Smiles +80%", 10000, 200.00),
        ("Bonus Transferência LATAM Pass +60%", 10000, 200.00),
        ("Transferência Iberia Plus (10.000 pts)", 20000, 400.00),
        ("Transferência British Airways Executive Club", 20000, 400.00),
        ("Transferência United MileagePlus", 30000, 600.00)
    ]
}


def generate_cpf(idx):
    # Gera CPF sintético determinístico e válido visualmente
    base = f"{100000000 + idx:09d}"
    # cálculo simples de dígitos verificadores
    d1 = sum(int(base[i]) * (10 - i) for i in range(9)) % 11
    d1 = 0 if d1 < 2 else 11 - d1
    d2 = sum(int((base + str(d1))[i]) * (11 - i) for i in range(10)) % 11
    d2 = 0 if d2 < 2 else 11 - d2
    return f"{base[:3]}.{base[3:6]}.{base[6:9]}-{d1}{d2}"

def generate_data():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    random.seed(42)  # Reprodutibilidade

    now = datetime(2026, 7, 29, 10, 0, 0, tzinfo=timezone.utc)
    start_date = datetime(2022, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

    # 1. GENERATE CUSTOMERS
    customers = []
    print("Gerando clientes...")
    for i in range(1, NUM_CUSTOMERS + 1):
        cust_id = f"CUST-{10000 + i}"
        cpf = generate_cpf(i)
        fn = random.choice(FIRST_NAMES)
        ln = random.choice(LAST_NAMES)
        name = f"{fn} {ln}"
        email = f"{fn.lower()}.{ln.lower()}{random.randint(10, 99)}@example.com"
        phone = f"+55119{random.randint(10000000, 99999999)}"
        birth_year = random.randint(1965, 2002)
        birth_date = f"{birth_year}-{random.randint(1, 12):02d}-{random.randint(1, 28):02d}"
        gender = random.choice(["Feminino", "Masculino", "Outro"])
        city, state = random.choice(CITIES_STATES)
        tier = random.choice(TIERS)
        
        # Customer creation date between 2022 and early 2025
        created_dt = start_date + timedelta(days=random.randint(0, 1000))
        created_date_str = created_dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        # Perfil de churn/comportamento
        # 15% Churners (pararam de comprar há > 180 dias)
        # 25% VIP / High CLV (compras frequentes)
        # 60% Regulares
        profile_type = random.choices(
            ["churned", "vip", "regular"],
            weights=[0.15, 0.25, 0.60]
        )[0]

        customers.append({
            "CustomerId": cust_id,
            "CPF": cpf,
            "Name": name,
            "Email": email,
            "Phone": phone,
            "BirthDate": birth_date,
            "Gender": gender,
            "City": city,
            "State": state,
            "LiveloTier": tier,
            "CreatedDate": created_date_str,
            "_profile_type": profile_type,
            "_created_dt": created_dt,
            "_preferred_category": random.choice(list(CATEGORIES.keys())),
            "_fn": fn,
            "_ln": ln
        })

    # Write customers.csv
    cust_file = os.path.join(OUTPUT_DIR, "customers.csv")
    with open(cust_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "CustomerId", "CPF", "Name", "Email", "Phone", "BirthDate", "Gender",
            "City", "State", "LiveloTier", "CreatedDate"
        ])
        writer.writeheader()
        for c in customers:
            row = {k: c[k] for k in writer.fieldnames}
            writer.writerow(row)

    # 2. GENERATE PRODUCTS
    products = []
    print("Gerando catálogo de produtos...")
    prod_idx = 1
    for cat, items in CATEGORIES.items():
        for name, points, val_brl in items:
            prod_id = f"PROD-{prod_idx:03d}"
            products.append({
                "ProductId": prod_id,
                "ProductName": name,
                "Category": cat,
                "PointsPrice": points,
                "ValueBRL": f"{val_brl:.2f}"
            })
            prod_idx += 1

    prod_file = os.path.join(OUTPUT_DIR, "products.csv")
    with open(prod_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["ProductId", "ProductName", "Category", "PointsPrice", "ValueBRL"])
        writer.writeheader()
        writer.writerows(products)

    # 3. GENERATE TRANSACTIONS
    print("Gerando histórico transacional...")
    transactions = []
    txn_id_counter = 800001

    # Map category to products list
    prods_by_cat = {}
    for p in products:
        prods_by_cat.setdefault(p["Category"], []).append(p)

    for c in customers:
        p_type = c["_profile_type"]
        c_dt = c["_created_dt"]
        pref_cat = c["_preferred_category"]

        # Determinar janela final de compras e aumentar densidade de transações para atender aos requisitos de IA do D365 CI
        if p_type == "churned":
            # Parou entre 180 e 500 dias atrás
            last_possible_date = now - timedelta(days=random.randint(180, 500))
            num_txns = random.randint(8, 18)
        elif p_type == "vip":
            last_possible_date = now - timedelta(days=random.randint(1, 20))
            num_txns = random.randint(35, 75)
        else:  # regular
            last_possible_date = now - timedelta(days=random.randint(5, 90))
            num_txns = random.randint(18, 38)

        if last_possible_date < c_dt:
            last_possible_date = c_dt + timedelta(days=30)

        total_days = (last_possible_date - c_dt).days
        if total_days <= 0:
            total_days = 1

        for _ in range(num_txns):
            # Data da transação dentro da janela do cliente
            txn_days = random.randint(0, total_days)
            txn_dt = c_dt + timedelta(days=txn_days, hours=random.randint(0, 23), minutes=random.randint(0, 59))
            
            # Escolher produto (70% probabilidade de ser da categoria preferida - ajuda no Product Recommendation)
            if random.random() < 0.70 and pref_cat in prods_by_cat:
                prod = random.choice(prods_by_cat[pref_cat])
            else:
                prod = random.choice(products)

            qty = random.choices([1, 2, 3], weights=[0.85, 0.12, 0.03])[0]
            val_brl = float(prod["ValueBRL"]) * qty
            points_used = int(prod["PointsPrice"]) * qty

            # 0.5% devoluções/cancelamentos (IsReturn=True para o modelo de CLV)
            is_return = random.random() < 0.005
            if is_return:
                val_brl = -val_brl
                points_used = -points_used

            txn_type = random.choice(["Purchase", "Redemption", "Redemption", "Transfer"])

            transactions.append({
                "TransactionId": f"TXN-{txn_id_counter}",
                "CustomerId": c["CustomerId"],
                "ProductId": prod["ProductId"],
                "TransactionDate": txn_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "Quantity": qty,
                "TransactionAmount": f"{val_brl:.2f}",
                "PointsUsed": points_used,
                "TransactionType": txn_type,
                "IsReturn": "True" if is_return else "False",
                "_dt": txn_dt
            })
            txn_id_counter += 1

    # Ordenar transações por data
    transactions.sort(key=lambda x: x["_dt"])

    txn_file = os.path.join(OUTPUT_DIR, "transactions.csv")
    with open(txn_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "TransactionId", "CustomerId", "ProductId", "TransactionDate",
            "Quantity", "TransactionAmount", "PointsUsed", "TransactionType", "IsReturn"
        ])
        writer.writeheader()
        for t in transactions:
            row = {k: t[k] for k in writer.fieldnames}
            writer.writerow(row)

    # 4. GENERATE PRODUCT INTERACTIONS
    print("Gerando navegação e interações de produtos...")
    interactions = []
    int_id_counter = 100001

    for _ in range(NUM_INTERACTIONS):
        c = random.choice(customers)
        pref_cat = c["_preferred_category"]
        if random.random() < 0.65 and pref_cat in prods_by_cat:
            prod = random.choice(prods_by_cat[pref_cat])
        else:
            prod = random.choice(products)

        int_days = random.randint(0, (now - start_date).days)
        int_dt = start_date + timedelta(days=int_days, hours=random.randint(0, 23), minutes=random.randint(0, 59))

        int_type = random.choices(["View", "Wishlist", "CartAdd"], weights=[0.75, 0.15, 0.10])[0]

        interactions.append({
            "InteractionId": f"INT-{int_id_counter}",
            "CustomerId": c["CustomerId"],
            "ProductId": prod["ProductId"],
            "InteractionType": int_type,
            "InteractionDate": int_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "_dt": int_dt
        })
        int_id_counter += 1

    interactions.sort(key=lambda x: x["_dt"])

    int_file = os.path.join(OUTPUT_DIR, "product_interactions.csv")
    with open(int_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "InteractionId", "CustomerId", "ProductId", "InteractionType", "InteractionDate"
        ])
        writer.writeheader()
        for i in interactions:
            row = {k: i[k] for k in writer.fieldnames}
            writer.writerow(row)

    # 5. GENERATE CRM CASES (OCORRÊNCIAS DO CRM)
    print("Gerando ocorrências e casos de atendimento do CRM...")
    crm_cases = []
    case_id_counter = 500001

    case_subjects = [
        ("Pontos não creditados após compra parceira", "Pontuação/Acúmulo"),
        ("Atraso na entrega de produto resgatado", "Resgate/Entrega"),
        ("Dificuldade para cancelar assinatura do Clube Livelo", "Clube Livelo"),
        ("Erro ao transferir pontos para programa aéreo", "Pontuação/Acúmulo"),
        ("Produto entregue com avaria/defeito", "Resgate/Entrega"),
        ("Cobrança indevida da mensalidade do Clube Livelo", "Clube Livelo"),
        ("Voucher de Gift Card com código inválido", "Resgate/Entrega"),
        ("Solicitação de estorno de taxa de transferência", "Financeiro"),
        ("Dúvida sobre validade dos pontos expirando", "Atendimento"),
        ("Alteração de endereço de entrega de pedido", "Resgate/Entrega")
    ]

    channels = ["Chat Web", "App Livelo", "Telefone", "Reclame Aqui", "WhatsApp"]
    priorities = ["Low", "Medium", "High", "Critical"]
    statuses = ["Closed", "Resolved", "In Progress", "Escalated"]

    for c in customers:
        p_type = c["_profile_type"]
        c_dt = c["_created_dt"]

        # Clientes Churned possuem taxa muito maior de reclamações não resolvidas e baixo CSAT
        if p_type == "churned":
            num_c_cases = random.choices([1, 2, 3, 4], weights=[0.30, 0.40, 0.20, 0.10])[0]
        elif p_type == "regular":
            num_c_cases = random.choices([0, 1, 2], weights=[0.60, 0.30, 0.10])[0]
        else:  # vip
            num_c_cases = random.choices([0, 1, 2], weights=[0.70, 0.25, 0.05])[0]

        for _ in range(num_c_cases):
            subj, cat = random.choice(case_subjects)
            chan = random.choice(channels)
            
            # Data de criação do chamado após cadastro do cliente
            days_after = random.randint(10, max(11, (now - c_dt).days))
            created_case_dt = c_dt + timedelta(days=days_after, hours=random.randint(0, 23), minutes=random.randint(0, 59))
            if created_case_dt > now:
                created_case_dt = now - timedelta(hours=random.randint(1, 48))

            if p_type == "churned":
                prio = random.choices(priorities, weights=[0.10, 0.20, 0.50, 0.20])[0]
                status = random.choices(statuses, weights=[0.30, 0.30, 0.20, 0.20])[0]
                csat = random.choices([1, 2, 3], weights=[0.60, 0.30, 0.10])[0]
            else:
                prio = random.choices(priorities, weights=[0.50, 0.35, 0.12, 0.03])[0]
                status = random.choices(statuses, weights=[0.70, 0.25, 0.04, 0.01])[0]
                csat = random.choices([3, 4, 5], weights=[0.15, 0.35, 0.50])[0]

            resolved_case_dt = created_case_dt + timedelta(days=random.randint(1, 10)) if status in ["Closed", "Resolved"] else None
            resolved_str = resolved_case_dt.strftime("%Y-%m-%dT%H:%M:%SZ") if resolved_case_dt else ""

            crm_cases.append({
                "CaseId": f"CASE-{case_id_counter}",
                "CustomerId": c["CustomerId"],
                "Subject": subj,
                "Category": cat,
                "Channel": chan,
                "Priority": prio,
                "Status": status,
                "SatisfactionScore": csat,
                "CreatedDate": created_case_dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "ResolvedDate": resolved_str,
                "_dt": created_case_dt
            })
            case_id_counter += 1

    crm_cases.sort(key=lambda x: x["_dt"])

    case_file = os.path.join(OUTPUT_DIR, "crm_cases.csv")
    with open(case_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "CaseId", "CustomerId", "Subject", "Category", "Channel", "Priority",
            "Status", "SatisfactionScore", "CreatedDate", "ResolvedDate"
        ])
        writer.writeheader()
        for cs in crm_cases:
            row = {k: cs[k] for k in writer.fieldnames}
            writer.writerow(row)

    # 6. GENERATE WEB & APP CADASTRO PROFILES (FONTE NÃO-TRANSACTIONAL PARA GOLDEN RECORD / UNIFY)
    print("Gerando base de cadastros Web/App (Golden Record / Unify)...")
    web_profiles = []
    streets = ["Av. Paulista", "Rua Augusta", "Av. Faria Lima", "Rua Oscar Freire", "Rua das Flores", "Av. Brasil", "Rua XV de Novembro"]
    channels = ["Portal Web", "App iOS", "App Android", "Parceiro Bank"]

    for idx, c in enumerate(customers, start=1):
        web_id = f"WEB-{70000 + idx}"
        
        # Simulando variações comuns no Golden Record (Unify Match Rules)
        # 10% CPF sem pontuação
        cpf_val = c["CPF"].replace(".", "").replace("-", "") if random.random() < 0.10 else c["CPF"]
        
        # 15% nome com caixa alta ou abreviação leve
        if random.random() < 0.15:
            full_name = c["Name"].upper()
        elif random.random() < 0.10:
            full_name = f"{c['_fn']} {c['_ln'][0]}."
        else:
            full_name = c["Name"]

        # 10% e-mail secundário
        if random.random() < 0.10:
            email_val = f"{c['_fn'].lower()}{random.randint(100, 999)}@gmail.com"
        else:
            email_val = c["Email"].upper() if random.random() < 0.20 else c["Email"]

        # Telefone formatado ou limpo
        phone_raw = c["Phone"].replace("+55", "")
        phone_val = phone_raw if random.random() < 0.30 else c["Phone"]

        street = random.choice(streets)
        num = random.randint(10, 2500)
        zip_code = f"{random.randint(10000, 99999):05d}-{random.randint(100, 999):03d}"
        
        opt_in = random.choices(["True", "False"], weights=[0.85, 0.15])[0]
        channel = random.choice(channels)

        last_login_dt = c["_created_dt"] + timedelta(days=random.randint(1, 800))
        if last_login_dt > now:
            last_login_dt = now - timedelta(days=random.randint(1, 30))

        web_profiles.append({
            "WebProfileId": web_id,
            "CPF": cpf_val,
            "FullName": full_name,
            "Email": email_val,
            "MobilePhone": phone_val,
            "BirthDate": c["BirthDate"],
            "StreetAddress": f"{street}, {num}",
            "ZipCode": zip_code,
            "City": c["City"],
            "State": c["State"],
            "MarketingOptIn": opt_in,
            "RegistrationChannel": channel,
            "LastLoginDate": last_login_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        })

    web_file = os.path.join(OUTPUT_DIR, "web_app_profiles.csv")
    with open(web_file, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "WebProfileId", "CPF", "FullName", "Email", "MobilePhone", "BirthDate",
            "StreetAddress", "ZipCode", "City", "State", "MarketingOptIn",
            "RegistrationChannel", "LastLoginDate"
        ])
        writer.writeheader()
        writer.writerows(web_profiles)

    # Self-check assertion (Ponytail rule: Runnable check / self-check)
    assert os.path.exists(cust_file) and os.path.getsize(cust_file) > 0
    assert os.path.exists(prod_file) and os.path.getsize(prod_file) > 0
    assert os.path.exists(txn_file) and os.path.getsize(txn_file) > 0
    assert os.path.exists(int_file) and os.path.getsize(int_file) > 0
    assert os.path.exists(case_file) and os.path.getsize(case_file) > 0
    assert os.path.exists(web_file) and os.path.getsize(web_file) > 0

    print(f"\n[OK] Dados sintéticos gerados com sucesso na pasta: {OUTPUT_DIR}")
    print(f"- Clientes: {len(customers)} em customers.csv")
    print(f"- Produtos: {len(products)} em products.csv")
    print(f"- Transações: {len(transactions)} em transactions.csv")
    print(f"- Interações: {len(interactions)} em product_interactions.csv")
    print(f"- Casos CRM: {len(crm_cases)} em crm_cases.csv")
    print(f"- Cadastros Web/App: {len(web_profiles)} em web_app_profiles.csv")


if __name__ == "__main__":
    generate_data()
