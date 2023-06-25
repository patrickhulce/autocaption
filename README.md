# Usage

```bash

# Setup JS deps
npm i

# Setup Python deps
conda env create -f environment.yml
conda activate autocaption

# Setup your files
cat > ./file.csv <<EOF
URL,ANYTHING ELSE
https://www.google.com/images/branding/googlelogo/2x/googlelogo_light_color_272x92dp.png,other fields
EOF

# Run autocaption
npm start -- ./file.csv
```

## Prerequisites

You'll need a working conda environment.

```sh
brew install miniconda # Install miniconda for managing python environments
conda init "$(basename "${SHELL}")" # Setup conda in your shell
conda config --set auto_activate_base false # (If you don't normally program in python), disable it from autoloading.
```

# Contributing

## Modifying Python Deps

```sh
conda activate autocaption
conda install pytorch torchvision -c pytorch # Or whatever deps you're adding.
conda env export --from-history > environment.yml # Update the equivalent of `package.json`
```
