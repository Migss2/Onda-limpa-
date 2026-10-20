CREATE DATABASE onda_limpa;

USE onda_limpa;

CREATE TABLE voluntarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    telefone VARCHAR(20),
    data_cadastro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE locais (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    endereco VARCHAR(255) NOT NULL,
    descricao TEXT,
    status ENUM('ativo', 'inativo') DEFAULT 'ativo'
);

CREATE TABLE acoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    titulo VARCHAR(150) NOT NULL,
    descricao TEXT,
    data_acao DATE NOT NULL,
    local_id INT,
    FOREIGN KEY (local_id) REFERENCES locais(id)
);

CREATE TABLE participacoes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    voluntario_id INT NOT NULL,
    acao_id INT NOT NULL,
    data_inscricao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (voluntario_id) REFERENCES voluntarios(id),
    FOREIGN KEY (acao_id) REFERENCES acoes(id),
    UNIQUE (voluntario_id, acao_id)
);

CREATE TABLE coletas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    acao_id INT NOT NULL,
    tipo_residuo VARCHAR(80) NOT NULL,
    quantidade DECIMAL(10,2) NOT NULL,
    unidade VARCHAR(20) DEFAULT 'kg',
    data_coleta DATE NOT NULL,
    FOREIGN KEY (acao_id) REFERENCES acoes(id)
);

INSERT INTO voluntarios (nome, email, telefone)
VALUES ('João Silva', 'joao@email.com', '51999999999');

INSERT INTO locais (nome, endereco, descricao)
VALUES (
    'Praia Central',
    'Avenida Beira-Mar',
    'Local para ações de limpeza ambiental'
);

SELECT
    a.titulo,
    a.data_acao,
    l.nome AS local
FROM acoes a
LEFT JOIN locais l ON a.local_id = l.id;

SELECT
    a.titulo,
    c.tipo_residuo,
    SUM(c.quantidade) AS total_recolhido,
    c.unidade
FROM coletas c
JOIN acoes a ON c.acao_id = a.id
GROUP BY a.id, a.titulo, c.tipo_residuo, c.unidade;